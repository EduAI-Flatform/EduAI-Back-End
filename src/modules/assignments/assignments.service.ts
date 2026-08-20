import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CourseStatus,
  Prisma,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { MAX_UNPAGINATED_API_ITEMS } from '../../common/performance/list-limits';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { LearningPathService } from '../courses/learning-path.service';
import { CourseCompletionService } from '../courses/course-completion.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { AssignmentStorageService } from './assignment-storage.service';
import { UploadedAssignmentFile } from './types/assignment-upload.types';

const assignmentResponseSelect = {
  id: true,
  courseId: true,
  lessonId: true,
  title: true,
  description: true,
  instructions: true,
  rubric: true,
  rubricCriteria: true,
  finalScorePolicy: true,
  allowedFileMimeTypes: true,
  maxFileSizeBytes: true,
  dueDate: true,
  maxScore: true,
  isRequired: true,
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
  fileKey: true,
  fileName: true,
  fileSize: true,
  fileMimeType: true,
  version: true,
  isLate: true,
  rubricScores: true,
  score: true,
  feedback: true,
  status: true,
  submittedAt: true,
  gradedAt: true,
  gradedById: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.SubmissionSelect;

export type AssignmentResponse = Prisma.AssignmentGetPayload<{
  select: typeof assignmentResponseSelect;
}>;

type StoredSubmissionResponse = Prisma.SubmissionGetPayload<{
  select: typeof submissionResponseSelect;
}>;

export type SubmissionResponse = Omit<StoredSubmissionResponse, 'user' | 'fileKey'> & {
  student: StoredSubmissionResponse['user'];
};

export interface DeletedAssignmentResponse {
  deleted: true;
}

type ManageableAssignment = AssignmentResponse & {
  course: { instructorId: string };
};

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly courseCompletionService: CourseCompletionService,
    @Optional() private readonly learningPathService?: LearningPathService,
    @Optional() private readonly assignmentStorageService?: AssignmentStorageService,
  ) {}

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
        instructions: input.instructions,
        rubric: input.rubric,
        rubricCriteria: this.toNullableJson(input.rubricCriteria as Prisma.InputJsonValue | null | undefined),
        finalScorePolicy: input.finalScorePolicy ?? 'latest',
        allowedFileMimeTypes: input.allowedFileMimeTypes,
        maxFileSizeBytes: input.maxFileSizeBytes,
        dueDate: this.toOptionalDate(input.dueDate),
        maxScore: input.maxScore,
        isRequired: input.isRequired ?? true,
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
      take: MAX_UNPAGINATED_API_ITEMS,
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
    if (canStudy && this.learningPathService) {
      await this.learningPathService.assertStudentStepAccessible(
        user.id,
        assignmentId,
        'ASSIGNMENT',
      );
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
        instructions: input.instructions,
        rubric: input.rubric,
        rubricCriteria: this.toNullableJson(input.rubricCriteria as Prisma.InputJsonValue | null | undefined),
        finalScorePolicy: input.finalScorePolicy,
        allowedFileMimeTypes: input.allowedFileMimeTypes,
        maxFileSizeBytes: input.maxFileSizeBytes,
        dueDate: this.toOptionalDate(input.dueDate),
        maxScore: input.maxScore,
        isRequired: input.isRequired,
      }),
      select: assignmentResponseSelect,
    });
  }

  async publishAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    await this.findManageableAssignmentOrThrow(user, assignmentId);
    return this.prisma.$transaction(async (tx) => {
      const publishedAssignment = await tx.assignment.update({
        where: { id: assignmentId },
        data: { status: AssignmentStatus.published },
        select: assignmentResponseSelect,
      });
      await this.auditService.record(
        {
          actorId: user.id,
          action: AuditAction.AssignmentPublished,
          target: { type: 'assignment', id: assignmentId },
          metadata: { status: AssignmentStatus.published },
        },
        tx,
      );
      return publishedAssignment;
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
    file?: UploadedAssignmentFile,
  ): Promise<SubmissionResponse> {
    if (!input.content && !file) {
      throw new BadRequestException('Submission requires text or file');
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
      select: {
        id: true,
        courseId: true,
        dueDate: true,
        allowedFileMimeTypes: true,
        maxFileSizeBytes: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      assignmentId,
      'ASSIGNMENT',
    );

    if (file && !this.assignmentStorageService) {
      throw new BadRequestException('Assignment file storage is unavailable');
    }

    const storedFile = file
      ? await this.assignmentStorageService!.upload(file, {
          allowedMimeTypes: assignment.allowedFileMimeTypes,
          maxFileSizeBytes: assignment.maxFileSizeBytes,
        })
      : undefined;

    try {
      const transactionResult = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "assignments" WHERE "id" = ${assignmentId} FOR UPDATE`,
        );
        const previousSubmission = await tx.submission.findFirst({
          where: { assignmentId, userId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const submittedAt = new Date();
        const created = await tx.submission.create({
          data: {
            assignmentId,
            userId,
            content: input.content,
            fileUrl: null,
            ...(storedFile
              ? {
                  fileKey: storedFile.key,
                  fileName: file!.originalname,
                  fileSize: file!.size,
                  fileMimeType: file!.mimetype,
                }
              : {}),
            version: (previousSubmission?.version ?? 0) + 1,
            isLate: Boolean(assignment.dueDate && submittedAt > assignment.dueDate),
            submittedAt,
            status: SubmissionStatus.submitted,
          },
          select: submissionResponseSelect,
        });
        const completion = await this.courseCompletionService.evaluateAndSync(
          tx,
          userId,
          assignment.courseId,
        );
        return { submission: created, certificateIssued: completion.certificateIssued };
      });
      if (transactionResult.certificateIssued) {
        await this.courseCompletionService.publishCertificateIssued(
          transactionResult.certificateIssued,
        );
      }
      return this.toSubmissionResponse(transactionResult.submission);
    } catch (error) {
      throw error;
    }
  }

  async getMySubmission(
    userId: string,
    assignmentId: string,
  ): Promise<SubmissionResponse> {
    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      assignmentId,
      'ASSIGNMENT',
    );
    const submission = await this.prisma.submission.findFirst({
      where: {
        assignmentId,
        userId,
        assignment: {
          deletedAt: null,
          status: AssignmentStatus.published,
          course: {
            deletedAt: null,
            status: CourseStatus.published,
            enrollments: { some: { userId } },
          },
        },
      },
      orderBy: { version: 'desc' },
      select: {
        ...submissionResponseSelect,
        assignment: { select: { finalScorePolicy: true } },
      },
    });

    if (!submission) throw new NotFoundException('Submission not found');

    if (submission.assignment.finalScorePolicy === 'highest') {
      const highestGraded = await this.prisma.submission.findFirst({
        where: { assignmentId, userId, status: SubmissionStatus.graded },
        orderBy: [{ score: 'desc' }, { version: 'desc' }],
        select: submissionResponseSelect,
      });
      if (highestGraded) return this.toSubmissionResponse(highestGraded);
    }
    const { assignment: _assignment, ...response } = submission;
    return this.toSubmissionResponse(response);
  }

  async listMySubmissions(
    userId: string,
    assignmentId: string,
  ): Promise<SubmissionResponse[]> {
    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      assignmentId,
      'ASSIGNMENT',
    );
    const submissions = await this.prisma.submission.findMany({
      where: {
        assignmentId,
        userId,
        assignment: {
          deletedAt: null,
          status: AssignmentStatus.published,
          course: {
            deletedAt: null,
            status: CourseStatus.published,
            enrollments: { some: { userId } },
          },
        },
      },
      orderBy: { version: 'desc' },
      take: MAX_UNPAGINATED_API_ITEMS,
      select: submissionResponseSelect,
    });
    return Promise.all(submissions.map((submission) => this.toSubmissionResponse(submission)));
  }

  async listSubmissions(
    user: AuthenticatedUser,
    assignmentId: string,
  ): Promise<SubmissionResponse[]> {
    const assignment = await this.findManageableAssignmentOrThrow(user, assignmentId);
    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId },
      orderBy: { submittedAt: 'desc' },
      take: MAX_UNPAGINATED_API_ITEMS,
      select: submissionResponseSelect,
    });
    return Promise.all(submissions.map((submission) => this.toSubmissionResponse(submission)));
  }

  async gradeSubmission(
    user: AuthenticatedUser,
    submissionId: string,
    input: GradeSubmissionDto,
  ): Promise<SubmissionResponse> {
    const submission = await this.prisma.submission.findFirst({
      where: {
        id: submissionId,
        assignment: {
          deletedAt: null,
          course: { deletedAt: null },
        },
      },
      select: {
        ...submissionResponseSelect,
        assignment: {
          select: {
            dueDate: true,
            maxScore: true,
            rubricCriteria: true,
            finalScorePolicy: true,
            course: { select: { instructorId: true } },
          },
        },
      },
    });
    if (
      !submission ||
      !this.canManage(user, submission.assignment.course.instructorId)
    ) {
      throw new NotFoundException('Submission not found');
    }
    const rubricScore = this.resolveRubricScore(
      input.rubricScores,
      submission.assignment.rubricCriteria,
    );
    const score = rubricScore ?? input.score;
    if (score > submission.assignment.maxScore) {
      throw new BadRequestException('Score cannot exceed assignment max score');
    }

    const gradedSubmission = await this.prisma.$transaction(async (tx) => {
      const graded = await tx.submission.update({
        where: { id: submissionId },
        data: {
          score,
          feedback: input.feedback,
          rubricScores: input.rubricScores ?? undefined,
          status: SubmissionStatus.graded,
          gradedAt: new Date(),
          gradedById: user.id,
        },
        select: submissionResponseSelect,
      });
      await this.auditService.record(
        {
          actorId: user.id,
          action: AuditAction.SubmissionGraded,
          target: { type: 'submission', id: submissionId },
          metadata: {
            assignmentId: submission.assignmentId,
            score,
            status: SubmissionStatus.graded,
          },
        },
        tx,
      );
      return graded;
    });
    return this.toSubmissionResponse(gradedSubmission);
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

  private async toSubmissionResponse(submission: StoredSubmissionResponse): Promise<SubmissionResponse> {
    const { user, fileKey, fileUrl: _legacyFileUrl, ...response } = submission;
    const storageService = this.assignmentStorageService;
    if (fileKey && !storageService) {
      throw new InternalServerErrorException('Assignment file storage is unavailable');
    }

    return {
      ...response,
      fileUrl: fileKey
        ? await storageService!.createDownloadUrl(fileKey)
        : null,
      student: user,
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

  private toNullableJson(
    value: Prisma.InputJsonValue | null | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (value === undefined) return undefined;
    return value === null ? Prisma.JsonNull : value;
  }

  private resolveRubricScore(
    rubricScores: Prisma.InputJsonArray | null | undefined,
    rubricCriteria: Prisma.JsonValue | null,
  ): number | null {
    if (!rubricCriteria || !Array.isArray(rubricCriteria)) return null;
    if (!rubricScores || !Array.isArray(rubricScores)) {
      throw new BadRequestException('Rubric scores are required');
    }
    const criteria = rubricCriteria.map((criterion) => {
      if (
        !criterion ||
        typeof criterion !== 'object' ||
        typeof (criterion as { criterion?: unknown }).criterion !== 'string' ||
        typeof (criterion as { maxScore?: unknown }).maxScore !== 'number'
      ) {
        throw new BadRequestException('Assignment rubric is invalid');
      }
      return criterion as { criterion: string; maxScore: number };
    });
    if (rubricScores.length !== criteria.length) {
      throw new BadRequestException('Each rubric criterion must be scored once');
    }
    const scores = rubricScores.map((rubricScore) => {
      if (
        !rubricScore ||
        typeof rubricScore !== 'object' ||
        typeof (rubricScore as { criterion?: unknown }).criterion !== 'string' ||
        typeof (rubricScore as { score?: unknown }).score !== 'number'
      ) {
        throw new BadRequestException('Rubric score is invalid');
      }
      return rubricScore as { criterion: string; score: number };
    });
    const criteriaByName = new Map(criteria.map((criterion) => [criterion.criterion, criterion.maxScore]));
    if (
      new Set(scores.map((rubricScore) => rubricScore.criterion)).size !== scores.length ||
      scores.some((rubricScore) => {
        const maxScore = criteriaByName.get(rubricScore.criterion);
        return maxScore === undefined || rubricScore.score < 0 || rubricScore.score > maxScore;
      })
    ) {
      throw new BadRequestException('Rubric scores do not match assignment criteria');
    }
    return scores.reduce((total, rubricScore) => total + rubricScore.score, 0);
  }
}
