import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Course,
  CourseStatus,
  CourseVisibility,
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { LearningPathService } from '../courses/learning-path.service';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import { LessonMediaStorageService } from './lesson-media-storage.service';
import { UploadedLessonDocument, VideoUploadAuthorization } from './types/lesson-media-upload.types';

export interface DeleteLessonResponse {
  deleted: true;
}

const lessonSummarySelect = {
  id: true,
  courseId: true,
  title: true,
  slug: true,
  type: true,
  orderIndex: true,
  durationMinutes: true,
  isPreview: true,
  isRequired: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LessonSelect;

const lessonResponseSelect = {
  ...lessonSummarySelect,
  content: true,
  videoUrl: true,
  videoStorageKey: true,
  documentUrl: true,
  documentStorageKey: true,
} satisfies Prisma.LessonSelect;

export type LessonSummary = Prisma.LessonGetPayload<{
  select: typeof lessonSummarySelect;
}>;

type StoredLessonResponse = Prisma.LessonGetPayload<{
  select: typeof lessonResponseSelect;
}>;
export type LessonResponse = Omit<StoredLessonResponse, 'videoStorageKey' | 'documentStorageKey'>;

type LessonWithCourse = StoredLessonResponse & {
  course: Pick<Course, 'instructorId'>;
};

type LessonDetailRecord = StoredLessonResponse & {
  course: {
    instructorId: string;
    status: CourseStatus;
    visibility: CourseVisibility;
    moderationStatus: ModerationStatus;
    enrollments?: Array<{ id: string }>;
  };
};

@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly learningPathService?: LearningPathService,
    private readonly mediaStorage?: LessonMediaStorageService,
  ) {}

  async authorizeVideoUpload(
    user: AuthenticatedUser,
    courseId: string,
    mimeType: string,
    size: number,
  ): Promise<VideoUploadAuthorization> {
    await this.assertManagedCourse(user, courseId);
    return this.requireMediaStorage().authorizeVideoUpload(courseId, mimeType, size);
  }

  async finalizeVideoUpload(
    user: AuthenticatedUser,
    courseId: string,
    storageKey: string,
    mimeType: string,
    size: number,
  ): Promise<{ storageKey: string }> {
    await this.assertManagedCourse(user, courseId);
    return this.requireMediaStorage().finalizeVideoUpload(
      courseId,
      storageKey,
      mimeType,
      size,
    );
  }

  async uploadDocument(
    user: AuthenticatedUser,
    courseId: string,
    file: UploadedLessonDocument | undefined,
  ): Promise<{ storageKey: string }> {
    await this.assertManagedCourse(user, courseId);
    return this.requireMediaStorage().uploadDocument(courseId, file);
  }

  async discardMedia(
    user: AuthenticatedUser,
    courseId: string,
    storageKey: string,
  ): Promise<{ deleted: true }> {
    await this.assertManagedCourse(user, courseId);
    const references = await this.prisma.lesson.count({
      where: {
        courseId,
        deletedAt: null,
        OR: [
          { videoStorageKey: storageKey },
          { documentStorageKey: storageKey },
        ],
      },
    });
    if (references > 0) {
      throw new ConflictException('Lesson media is still referenced');
    }
    await this.requireMediaStorage().discard(courseId, storageKey);
    return { deleted: true };
  }

  async getLesson(
    user: AuthenticatedUser | undefined,
    lessonId: string,
  ): Promise<LessonResponse> {
    const courseAccessSelect = {
      instructorId: true,
      status: true,
      visibility: true,
      moderationStatus: true,
      ...(user
        ? {
            enrollments: {
              where: {
                userId: user.id,
                status: { in: ['active', 'completed'] },
              },
              select: { id: true },
              take: 1,
            },
          }
        : {}),
    } satisfies Prisma.CourseSelect;
    const lesson = (await this.prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
        course: {
          deletedAt: null,
        },
      },
      select: {
        ...lessonResponseSelect,
        course: {
          select: courseAccessSelect,
        },
      },
    })) as LessonDetailRecord | null;

    if (!lesson || !this.canViewLesson(user, lesson)) {
      throw new NotFoundException('Lesson not found');
    }

    if (
      user &&
      lesson.course.enrollments &&
      lesson.course.enrollments.length > 0 &&
      !lesson.isPreview &&
      !this.canManageCourse(user, lesson.course)
    ) {
      if (this.learningPathService) {
        await this.learningPathService.assertLessonAccessible(user, lessonId);
      }
    }

    const { course: _course, ...stored } = lesson;
    return this.toLessonResponse(stored);
  }

  async listLessons(courseId: string): Promise<LessonSummary[]> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.clear,
      },
      select: { id: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return this.findLessonSummaries(courseId);
  }

  async listInstructorLessons(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<LessonSummary[]> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    return this.findLessonSummaries(courseId);
  }

  async createLesson(
    user: AuthenticatedUser,
    courseId: string,
    input: CreateLessonDto,
  ): Promise<LessonResponse> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);
    await this.assertInputMedia(courseId, input.videoStorageKey, input.documentStorageKey);

    let created: StoredLessonResponse;
    try {
      created = await this.prisma.lesson.create({
        data: {
          courseId,
          title: input.title,
          slug: input.slug,
          type: input.type,
          content: input.content,
          videoUrl: input.videoUrl,
          videoStorageKey: input.videoStorageKey,
          documentUrl: input.documentUrl,
          documentStorageKey: input.documentStorageKey,
          orderIndex: input.orderIndex,
          durationMinutes: input.durationMinutes,
          isPreview: input.isPreview ?? false,
          isRequired: input.isRequired ?? true,
        },
        select: lessonResponseSelect,
      });
    } catch (error) {
      await this.cleanupInputMedia(input.videoStorageKey, input.documentStorageKey);
      if (this.isLessonUniquenessConflict(error)) {
        throw new ConflictException(
          'Lesson slug or order index is already in use for this course',
        );
      }

      throw error;
    }
    return this.toLessonResponse(created);
  }

  async updateLesson(
    user: AuthenticatedUser,
    lessonId: string,
    input: UpdateLessonDto,
  ): Promise<LessonResponse> {
    const lesson = await this.findLessonOrThrow(lessonId);
    this.assertCanManageCourse(user, lesson.course);
    await this.assertInputMedia(
      lesson.courseId,
      input.videoStorageKey,
      input.documentStorageKey,
    );
    const data = this.removeUndefinedFields({
      title: input.title,
      slug: input.slug,
      type: input.type,
      content: input.content,
      videoUrl: input.videoUrl,
      videoStorageKey: input.videoStorageKey,
      documentUrl: input.documentUrl,
      documentStorageKey: input.documentStorageKey,
      orderIndex: input.orderIndex,
      durationMinutes: input.durationMinutes,
      isPreview: input.isPreview,
      isRequired: input.isRequired,
    });

    let updated: StoredLessonResponse;
    try {
      updated = await this.prisma.lesson.update({
        where: { id: lessonId },
        data,
        select: lessonResponseSelect,
      });
    } catch (error) {
      await this.cleanupInputMedia(input.videoStorageKey, input.documentStorageKey);
      if (this.isLessonUniquenessConflict(error)) {
        throw new ConflictException(
          'Lesson slug or order index is already in use for this course',
        );
      }

      throw error;
    }
    if (
      input.videoStorageKey !== undefined &&
      lesson.videoStorageKey &&
      input.videoStorageKey !== lesson.videoStorageKey
    ) {
      await this.deleteMediaBestEffort(lesson.videoStorageKey);
    }
    if (
      input.documentStorageKey !== undefined &&
      lesson.documentStorageKey &&
      input.documentStorageKey !== lesson.documentStorageKey
    ) {
      await this.deleteMediaBestEffort(lesson.documentStorageKey);
    }
    return this.toLessonResponse(updated);
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

    await this.cleanupInputMedia(lesson.videoStorageKey, lesson.documentStorageKey);

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
      select: { instructorId: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private findLessonSummaries(courseId: string): Promise<LessonSummary[]> {
    return this.prisma.lesson.findMany({
      where: {
        courseId,
        deletedAt: null,
      },
      orderBy: {
        orderIndex: 'asc',
      },
      select: lessonSummarySelect,
    });
  }

  private async findLessonOrThrow(lessonId: string): Promise<LessonWithCourse> {
    const lesson = await this.prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
      },
      select: {
        ...lessonResponseSelect,
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

  private async assertManagedCourse(user: AuthenticatedUser, courseId: string): Promise<void> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);
  }

  private async assertInputMedia(
    courseId: string,
    videoStorageKey?: string | null,
    documentStorageKey?: string | null,
  ): Promise<void> {
    if (videoStorageKey) {
      await this.requireMediaStorage().assertLessonMedia(courseId, videoStorageKey, 'videos');
    }
    if (documentStorageKey) {
      await this.requireMediaStorage().assertLessonMedia(
        courseId,
        documentStorageKey,
        'documents',
      );
    }
  }

  private requireMediaStorage(): LessonMediaStorageService {
    if (!this.mediaStorage) throw new Error('Lesson media storage is not configured');
    return this.mediaStorage;
  }

  private async toLessonResponse(stored: StoredLessonResponse): Promise<LessonResponse> {
    const { videoStorageKey, documentStorageKey, ...response } = stored;
    return {
      ...response,
      videoUrl: videoStorageKey
        ? await this.requireMediaStorage().createDownloadUrl(videoStorageKey)
        : response.videoUrl,
      documentUrl: documentStorageKey
        ? await this.requireMediaStorage().createDownloadUrl(documentStorageKey)
        : response.documentUrl,
    };
  }

  private async cleanupInputMedia(
    videoStorageKey?: string | null,
    documentStorageKey?: string | null,
  ): Promise<void> {
    if (videoStorageKey) await this.deleteMediaBestEffort(videoStorageKey);
    if (documentStorageKey) await this.deleteMediaBestEffort(documentStorageKey);
  }

  private async deleteMediaBestEffort(storageKey: string): Promise<void> {
    try {
      const references = await this.prisma.lesson.count({
        where: {
          deletedAt: null,
          OR: [
            { videoStorageKey: storageKey },
            { documentStorageKey: storageKey },
          ],
        },
      });
      if (references > 0) return;
      await this.requireMediaStorage().delete(storageKey);
    } catch {
      // Media cleanup is best-effort after the authoritative DB transition.
    }
  }

  private canViewLesson(
    user: AuthenticatedUser | undefined,
    lesson: LessonDetailRecord,
  ): boolean {
    const publicPreview =
      lesson.isPreview &&
      lesson.course.status === CourseStatus.published &&
      lesson.course.visibility === CourseVisibility.public &&
      lesson.course.moderationStatus === ModerationStatus.clear;
    const canManage = Boolean(
      user && this.canManageCourse(user, lesson.course),
    );
    const isEnrolled = Boolean(
      user && lesson.course.enrollments && lesson.course.enrollments.length > 0,
    );

    return publicPreview || canManage || isEnrolled;
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
