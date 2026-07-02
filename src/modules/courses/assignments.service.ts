import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CourseStatus,
  Prisma,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';

const assignmentResponseSelect = {
  id: true,
  courseId: true,
  lessonId: true,
  title: true,
  description: true,
  dueDate: true,
  maxScore: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AssignmentSelect;

const submissionResponseSelect = {
  id: true,
  assignmentId: true,
  userId: true,
  content: true,
  fileUrl: true,
  score: true,
  feedback: true,
  status: true,
  submittedAt: true,
  gradedAt: true,
  gradedById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SubmissionSelect;

export type AssignmentResponse = Prisma.AssignmentGetPayload<{
  select: typeof assignmentResponseSelect;
}>;

type StoredSubmissionResponse = Prisma.SubmissionGetPayload<{
  select: typeof submissionResponseSelect;
}>;

export type SubmissionResponse = StoredSubmissionResponse & { isLate: boolean };

export interface DeletedAssignmentResponse {
  deleted: true;
}

type ManageableAssignment = AssignmentResponse & {
  course: { instructorId: string };
};

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async createAssignment(
    user: AuthenticatedUser,
    courseId: string,
    input: CreateAssignmentDto,
  ): Promise<AssignmentResponse> {
    await this.findManageableCourseOrThrow(user, courseId);
    await this.assertLessonBelongsToCourse(input.lessonId, courseId);
    return this.prisma.assignment.create({
      data: {
        courseId,
        lessonId: input.lessonId,
        title: input.title,
        description: input.description,
        dueDate: this.toOptionalDate(input.dueDate),
        maxScore: input.maxScore,
        status: AssignmentStatus.draft,
      },
      select: assignmentResponseSelect,
    });
  }

  async listAssignments(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<AssignmentResponse[]> {
    const access = await this.resolveCourseAccess(user, courseId);
    return this.prisma.assignment.findMany({
      where: {
        courseId,
        deletedAt: null,
        ...(access === 'manager' ? {} : { status: AssignmentStatus.published }),
      },
      orderBy: { dueDate: 'asc' },
      select: assignmentResponseSelect,
    });
  }

  async getAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        deletedAt: null,
      },
      select: {
        ...assignmentResponseSelect,
        course: {
          select: {
            instructorId: true,
            status: true,
            deletedAt: true,
            enrollments: {
              where: { userId: user.id },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    const canManage = assignment && this.canManage(user, assignment.course.instructorId);
    const canStudy = Boolean(
      assignment &&
        user.roles.includes(RoleName.student) &&
        assignment.status === AssignmentStatus.published &&
        assignment.course.status === CourseStatus.published &&
        !assignment.course.deletedAt &&
        assignment.course.enrollments.length > 0,
    );
    if (!assignment || (!canManage && !canStudy)) {
      throw new NotFoundException('Assignment not found');
    }
    const { course: _course, ...response } = assignment;
    return response;
  }

  async updateAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
    input: UpdateAssignmentDto,
  ): Promise<AssignmentResponse> {
    const assignment = await this.findManageableAssignmentOrThrow(user, assignmentId);
    await this.assertLessonBelongsToCourse(input.lessonId, assignment.courseId);
    return this.prisma.assignment.update({
      where: { id: assignmentId },
      data: this.removeUndefinedFields({
        lessonId: input.lessonId,
        title: input.title,
        description: input.description,
        dueDate: this.toOptionalDate(input.dueDate),
        maxScore: input.maxScore,
      }),
      select: assignmentResponseSelect,
    });
  }

  async publishAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    await this.findManageableAssignmentOrThrow(user, assignmentId);
    return this.prisma.assignment.update({
      where: { id: assignmentId },
      data: { status: AssignmentStatus.published },
      select: assignmentResponseSelect,
    });
  }

  async deleteAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<DeletedAssignmentResponse> {
    await this.findManageableAssignmentOrThrow(user, assignmentId);
    await this.prisma.assignment.update({
      where: { id: assignmentId },
      data: { deletedAt: new Date(), status: AssignmentStatus.archived },
    });
    return { deleted: true };
  }

  async submitAssignment(
    userId: string,
    assignmentId: string,
    input: SubmitAssignmentDto,
  ): Promise<SubmissionResponse> {
    if (!input.content && !input.fileUrl) {
      throw new BadRequestException('Submission requires text or file URL');
    }
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        deletedAt: null,
        status: AssignmentStatus.published,
        course: {
          deletedAt: null,
          status: CourseStatus.published,
          enrollments: { some: { userId } },
        },
      },
      select: { id: true, dueDate: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    try {
      const submission = await this.prisma.submission.create({
        data: {
          assignmentId,
          userId,
          content: input.content,
          fileUrl: input.fileUrl,
          status: SubmissionStatus.submitted,
        },
        select: submissionResponseSelect,
      });
      return this.toSubmissionResponse(submission, assignment.dueDate);
    } catch (error) {
      if (this.isUniqueConflict(error)) {
        throw new ConflictException('Assignment already submitted');
      }
      throw error;
    }
  }

  async listSubmissions(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<SubmissionResponse[]> {
    const assignment = await this.findManageableAssignmentOrThrow(user, assignmentId);
    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId },
      orderBy: { submittedAt: 'desc' },
      select: submissionResponseSelect,
    });
    return submissions.map((submission) =>
      this.toSubmissionResponse(submission, assignment.dueDate),
    );
  }

  private async findManageableCourseOrThrow(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<{ id: string; instructorId: string }> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true, instructorId: true },
    });
    if (!course || !this.canManage(user, course.instructorId)) {
      throw new NotFoundException('Course not found');
    }
    return course;
  }

  private async resolveCourseAccess(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<'manager' | 'student'> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
      select: {
        id: true,
        instructorId: true,
        status: true,
        enrollments: {
          where: { userId: user.id },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (course && this.canManage(user, course.instructorId)) return 'manager';
    if (
      course &&
      user.roles.includes(RoleName.student) &&
      course.status === CourseStatus.published &&
      course.enrollments.length > 0
    ) {
      return 'student';
    }
    throw new NotFoundException('Course not found');
  }

  private async findManageableAssignmentOrThrow(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<ManageableAssignment> {
    const assignment = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, deletedAt: null },
      select: {
        ...assignmentResponseSelect,
        course: { select: { instructorId: true } },
      },
    });
    if (!assignment || !this.canManage(user, assignment.course.instructorId)) {
      throw new NotFoundException('Assignment not found');
    }
    return assignment;
  }

  private async assertLessonBelongsToCourse(
    lessonId: string | undefined,
    courseId: string,
  ): Promise<void> {
    if (!lessonId) return;
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, courseId, deletedAt: null },
      select: { id: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found in course');
  }

  private canManage(user: AuthenticatedUser, instructorId: string): boolean {
    return user.roles.includes(RoleName.platform_admin) ||
      (user.roles.includes(RoleName.instructor) && user.id === instructorId);
  }

  private toSubmissionResponse(
    submission: StoredSubmissionResponse,
    dueDate: Date | null,
  ): SubmissionResponse {
    return {
      ...submission,
      isLate: Boolean(dueDate && submission.submittedAt > dueDate),
    };
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private toOptionalDate(
    value: string | null | undefined,
  ): Date | null | undefined {
    if (value === undefined || value === null) return value;
    return new Date(value);
  }

  private isUniqueConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      (typeof error === 'object' && error !== null && 'code' in error)
    ) && (error as { code?: string }).code === 'P2002';
  }
}
