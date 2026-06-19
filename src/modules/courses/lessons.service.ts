import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Course,
  CourseStatus,
  CourseVisibility,
  Lesson,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';

export interface DeleteLessonResponse {
  deleted: true;
}

export type LessonSummary = Pick<
  Lesson,
  | 'id'
  | 'courseId'
  | 'title'
  | 'slug'
  | 'type'
  | 'orderIndex'
  | 'durationMinutes'
  | 'isPreview'
  | 'createdAt'
  | 'updatedAt'
>;

type LessonWithCourse = Lesson & {
  course: Pick<Course, 'instructorId'>;
};

@Injectable()
export class LessonsService {
  constructor(private readonly prisma: PrismaService) {}

  async listLessons(courseId: string): Promise<LessonSummary[]> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
      select: { id: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return this.prisma.lesson.findMany({
      where: {
        courseId,
        deletedAt: null,
      },
      orderBy: {
        orderIndex: 'asc',
      },
      select: {
        id: true,
        courseId: true,
        title: true,
        slug: true,
        type: true,
        orderIndex: true,
        durationMinutes: true,
        isPreview: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async createLesson(
    user: AuthenticatedUser,
    courseId: string,
    input: CreateLessonDto,
  ): Promise<Lesson> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    try {
      return await this.prisma.lesson.create({
        data: {
          courseId,
          title: input.title,
          slug: input.slug,
          type: input.type,
          content: input.content,
          videoUrl: input.videoUrl,
          documentUrl: input.documentUrl,
          orderIndex: input.orderIndex,
          durationMinutes: input.durationMinutes,
          isPreview: input.isPreview ?? false,
        },
      });
    } catch (error) {
      if (this.isLessonUniquenessConflict(error)) {
        throw new ConflictException(
          'Lesson slug or order index is already in use for this course',
        );
      }

      throw error;
    }
  }

  async updateLesson(
    user: AuthenticatedUser,
    lessonId: string,
    input: UpdateLessonDto,
  ): Promise<Lesson> {
    const lesson = await this.findLessonOrThrow(lessonId);
    this.assertCanManageCourse(user, lesson.course);
    const data = this.removeUndefinedFields({
      title: input.title,
      slug: input.slug,
      type: input.type,
      content: input.content,
      videoUrl: input.videoUrl,
      documentUrl: input.documentUrl,
      orderIndex: input.orderIndex,
      durationMinutes: input.durationMinutes,
      isPreview: input.isPreview,
    });

    try {
      return await this.prisma.lesson.update({
        where: { id: lessonId },
        data,
      });
    } catch (error) {
      if (this.isLessonUniquenessConflict(error)) {
        throw new ConflictException(
          'Lesson slug or order index is already in use for this course',
        );
      }

      throw error;
    }
  }

  async deleteLesson(
    user: AuthenticatedUser,
    lessonId: string,
  ): Promise<DeleteLessonResponse> {
    const lesson = await this.findLessonOrThrow(lessonId);
    this.assertCanManageCourse(user, lesson.course);
    const result = await this.prisma.lesson.updateMany({
      where: {
        id: lessonId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Lesson not found');
    }

    return { deleted: true };
  }

  private async findCourseOrThrow(
    courseId: string,
  ): Promise<Pick<Course, 'instructorId'>> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private async findLessonOrThrow(lessonId: string): Promise<LessonWithCourse> {
    const lesson = await this.prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
      },
      include: {
        course: {
          select: {
            instructorId: true,
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    return lesson;
  }

  private assertCanManageCourse(
    user: AuthenticatedUser,
    course: Pick<Course, 'instructorId'>,
  ): void {
    if (!this.canManageCourse(user, course)) {
      throw new NotFoundException('Course not found');
    }
  }

  private canManageCourse(
    user: AuthenticatedUser,
    course: Pick<Course, 'instructorId'>,
  ): boolean {
    return (
      this.hasRole(user, RoleName.platform_admin) ||
      (this.hasRole(user, RoleName.instructor) && course.instructorId === user.id)
    );
  }

  private hasRole(user: AuthenticatedUser, role: RoleName): boolean {
    return user.roles.includes(role);
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private isLessonUniquenessConflict(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === 'P2002';
    }

    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
