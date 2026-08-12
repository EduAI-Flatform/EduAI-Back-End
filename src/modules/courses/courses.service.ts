import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatus,
  CourseVisibility,
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CourseThumbnailStorageService } from './course-thumbnail-storage.service';
import { CourseCompletionService } from './course-completion.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { ListInstructorCoursesQueryDto } from './dto/list-instructor-courses-query.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UploadedCourseThumbnail } from './types/course-thumbnail-upload.types';

const ENROLLMENT_ACTIVE_STATUS = 'active';
const ENROLLMENT_COMPLETED_STATUS = 'completed';
const PROGRESS_NOT_STARTED_STATUS = 'not_started';
const PROGRESS_COMPLETED_STATUS = 'completed';

const courseResponseSelect = {
  id: true,
  title: true,
  slug: true,
  description: true,
  thumbnailUrl: true,
  badge: true,
  featuredRank: true,
  priceAmountMinor: true,
  priceCurrency: true,
  level: true,
  status: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CourseSelect;

const courseCatalogSelect = {
  ...courseResponseSelect,
  instructor: {
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
      profile: {
        select: {
          headline: true,
          bio: true,
        },
      },
    },
  },
  lessons: {
    where: {
      deletedAt: null,
    },
    select: {
      durationMinutes: true,
    },
  },
  _count: {
    select: {
      lessons: {
        where: {
          deletedAt: null,
        },
      },
      enrollments: {
        where: {
          status: {
            in: [ENROLLMENT_ACTIVE_STATUS, ENROLLMENT_COMPLETED_STATUS],
          },
        },
      },
      reviews: true,
    },
  },
} satisfies Prisma.CourseSelect;

const courseCommandResponseSelect = {
  id: true,
  status: true,
} satisfies Prisma.CourseSelect;

const enrollmentCourseSelect = {
  id: true,
  title: true,
  slug: true,
  description: true,
  thumbnailUrl: true,
  level: true,
  status: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CourseSelect;

const buildEnrollmentResponseSelect = (userId: string) =>
  ({
    id: true,
    userId: true,
    courseId: true,
    status: true,
    enrolledAt: true,
    completedAt: true,
    course: {
      select: {
        ...enrollmentCourseSelect,
        lessons: {
          where: {
            deletedAt: null,
          },
          orderBy: {
            orderIndex: 'asc',
          },
          select: {
            id: true,
            title: true,
            slug: true,
            type: true,
            orderIndex: true,
            durationMinutes: true,
            isPreview: true,
            progress: {
              where: {
                userId,
              },
              select: {
                status: true,
                progressPercent: true,
              },
            },
          },
        },
      },
    },
  }) satisfies Prisma.EnrollmentSelect;

const publishedCourseWithLessonsSelect = {
  ...enrollmentCourseSelect,
  lessons: {
    where: {
      deletedAt: null,
    },
    orderBy: {
      orderIndex: 'asc',
    },
    select: {
      id: true,
      orderIndex: true,
    },
  },
} satisfies Prisma.CourseSelect;

const enrollmentSelect = {
  id: true,
  status: true,
  completedAt: true,
} satisfies Prisma.EnrollmentSelect;

const courseLessonsSelect = {
  lessons: {
    where: {
      deletedAt: null,
    },
    select: {
      id: true,
    },
  },
} satisfies Prisma.CourseSelect;

export type CourseResponse = Prisma.CourseGetPayload<{
  select: typeof courseResponseSelect;
}>;

type CourseCatalogRecord = Prisma.CourseGetPayload<{
  select: typeof courseCatalogSelect;
}>;

export type CourseCommandResponse = Prisma.CourseGetPayload<{
  select: typeof courseCommandResponseSelect;
}>;

export interface CoursePriceResponse {
  amountMinor: number;
  currency: string;
}

export interface CourseInstructorResponse {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  headline: string | null;
}

export interface CourseMetricsResponse {
  lessonCount: number;
  durationMinutes: number;
  enrollmentCount: number;
  ratingAverage: number | null;
  ratingCount: number;
}

interface CourseRatingAggregate {
  ratingAverage: number | null;
  ratingCount: number;
}

export type CourseCatalogResponse = Omit<
  CourseResponse,
  'priceAmountMinor' | 'priceCurrency'
> & {
  price: CoursePriceResponse | null;
  instructor: CourseInstructorResponse;
  metrics: CourseMetricsResponse;
};

export type CourseDetailResponse = CourseCatalogResponse & {
  lessonCount: number;
  instructor: CourseInstructorResponse & {
    bio: string | null;
  };
};

export interface PaginatedCourseResponse {
  items: CourseCatalogResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type EnrollmentRecord = Prisma.EnrollmentGetPayload<{
  select: ReturnType<typeof buildEnrollmentResponseSelect>;
}>;

type PublishedCourseWithLessons = Prisma.CourseGetPayload<{
  select: typeof publishedCourseWithLessonsSelect;
}>;

export interface EnrollmentCourseSummary {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  thumbnailUrl: string | null;
  level: PublishedCourseWithLessons['level'];
  status: PublishedCourseWithLessons['status'];
  visibility: PublishedCourseWithLessons['visibility'];
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentProgressSummary {
  completedLessons: number;
  totalLessons: number;
  progressPercent: number;
}

export interface EnrollmentResponse {
  id: string;
  courseId: string;
  status: string;
  enrolledAt: Date;
  completedAt: Date | null;
  course: EnrollmentCourseSummary;
  progress: EnrollmentProgressSummary;
}

export interface SuccessResponse {
  success: true;
  message: string;
}

export interface CourseProgressResponse {
  courseId: string;
  completedLessonIds: string[];
  completedLessons: number;
  totalLessons: number;
  progressPercent: number;
  completed: boolean;
}

const manageableCourseSelect = {
  ...courseResponseSelect,
  thumbnailStorageKey: true,
  instructorId: true,
  _count: {
    select: {
      lessons: {
        where: {
          deletedAt: null,
        },
      },
    },
  },
} satisfies Prisma.CourseSelect;

type ManageableCourse = Prisma.CourseGetPayload<{
  select: typeof manageableCourseSelect;
}>;

const courseDetailSelect = {
  ...courseCatalogSelect,
  instructorId: true,
  moderationStatus: true,
} satisfies Prisma.CourseSelect;

type CourseDetailRecord = Prisma.CourseGetPayload<{
  select: typeof courseDetailSelect;
}>;

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly thumbnailStorage: CourseThumbnailStorageService,
    private readonly auditService: AuditService,
    private readonly courseCompletionService: CourseCompletionService,
  ) {}

  async listCourses(): Promise<CourseCatalogResponse[]> {
    const courses = await this.prisma.course.findMany({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.clear,
      },
      orderBy: [{ featuredRank: 'asc' }, { createdAt: 'desc' }],
      select: courseCatalogSelect,
    });
    const ratingByCourseId = await this.getCourseRatingAggregates(
      courses.map((course) => course.id),
    );

    return courses.map((course) =>
      this.toCourseCatalogResponse(course, ratingByCourseId.get(course.id)),
    );
  }

  async listInstructorCourses(
    user: AuthenticatedUser,
    query: ListInstructorCoursesQueryDto,
  ): Promise<PaginatedCourseResponse> {
    this.assertInstructor(user);

    const page = query.page;
    const pageSize = query.pageSize;
    const where = this.buildInstructorCoursesWhere(user.id, query);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: {
          updatedAt: 'desc',
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: courseCatalogSelect,
      }),
    ]);

    const ratingByCourseId = await this.getCourseRatingAggregates(
      items.map((course) => course.id),
    );

    return {
      items: items.map((course) =>
        this.toCourseCatalogResponse(course, ratingByCourseId.get(course.id)),
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async createCourse(
    user: AuthenticatedUser,
    input: CreateCourseDto,
    thumbnail?: UploadedCourseThumbnail,
  ): Promise<CourseCommandResponse> {
    this.assertCanCreateCourse(user);
    this.assertValidPricePair(input.priceAmountMinor, input.priceCurrency);
    let slug = input.slug ?? (await this.createUniqueCourseSlug(input.title));
    const storedThumbnail = thumbnail
      ? await this.thumbnailStorage.uploadThumbnail(thumbnail)
      : undefined;
    const thumbnailUrl = storedThumbnail?.url ?? input.thumbnailUrl;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.course.create({
          data: {
            instructorId: user.id,
            title: input.title,
            slug,
            description: input.description,
            thumbnailUrl,
            thumbnailStorageKey: storedThumbnail?.key,
            badge: input.badge,
            priceAmountMinor: input.priceAmountMinor,
            priceCurrency: input.priceCurrency,
            level: input.level,
            status: CourseStatus.draft,
            visibility: input.visibility ?? CourseVisibility.public,
          },
          select: courseCommandResponseSelect,
        });
      } catch (error) {
        if (!this.isCourseSlugConflict(error)) {
          if (storedThumbnail) await this.deleteThumbnailBestEffort(storedThumbnail.key);
          throw error;
        }

        if (input.slug || attempt === 3) {
          if (storedThumbnail) await this.deleteThumbnailBestEffort(storedThumbnail.key);
          throw new ConflictException('Course slug is already in use');
        }

        slug = await this.createUniqueCourseSlug(input.title);
      }
    }

    throw new ConflictException('Course slug is already in use');
  }

  async updateCourse(
    user: AuthenticatedUser,
    courseId: string,
    input: UpdateCourseDto,
    thumbnail?: UploadedCourseThumbnail,
  ): Promise<CourseCommandResponse> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    if (input.status !== undefined) {
      throw new BadRequestException(
        'Use publish or archive course endpoints to change status',
      );
    }

    const priceAmountMinor =
      input.priceAmountMinor !== undefined
        ? input.priceAmountMinor
        : course.priceAmountMinor;
    const priceCurrency =
      input.priceCurrency !== undefined
        ? input.priceCurrency
        : course.priceCurrency;
    this.assertValidPricePair(priceAmountMinor, priceCurrency);

    const storedThumbnail = thumbnail
      ? await this.thumbnailStorage.uploadThumbnail(thumbnail)
      : undefined;
    const thumbnailUrl = storedThumbnail?.url ?? input.thumbnailUrl;
    const data = this.removeUndefinedFields({
      title: input.title,
      slug: input.slug,
      description: input.description,
      thumbnailUrl,
      thumbnailStorageKey:
        storedThumbnail?.key ?? (input.thumbnailUrl === null ? null : undefined),
      badge: input.badge,
      priceAmountMinor: input.priceAmountMinor,
      priceCurrency: input.priceCurrency,
      level: input.level,
      visibility: input.visibility,
    });

    try {
      const updated = await this.prisma.course.update({
        where: { id: courseId },
        data,
        select: courseCommandResponseSelect,
      });
      if (
        course.thumbnailStorageKey &&
        (storedThumbnail || input.thumbnailUrl === null)
      ) {
        await this.deleteThumbnailBestEffort(course.thumbnailStorageKey);
      }
      return updated;
    } catch (error) {
      if (storedThumbnail) await this.deleteThumbnailBestEffort(storedThumbnail.key);
      if (this.isCourseSlugConflict(error)) {
        throw new ConflictException('Course slug is already in use');
      }

      throw error;
    }
  }

  async publishCourse(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<CourseCommandResponse> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    if (course._count.lessons < 1) {
      throw new BadRequestException(
        'Course must have at least one lesson before publication',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const publishedCourse = await tx.course.update({
        where: { id: courseId },
        data: {
          status: CourseStatus.published,
        },
        select: courseCommandResponseSelect,
      });
      await this.auditService.record(
        {
          actorId: user.id,
          action: AuditAction.CoursePublished,
          target: { type: 'course', id: courseId },
          metadata: { status: CourseStatus.published },
        },
        tx,
      );
      return publishedCourse;
    });
  }

  async archiveCourse(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<CourseCommandResponse> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.archived,
      },
      select: courseCommandResponseSelect,
    });
  }

  async getCourse(
    courseId: string,
    user?: AuthenticatedUser,
  ): Promise<CourseDetailResponse> {
    const course = await this.findCourseDetailOrThrow(courseId);
    const isPublic =
      course.status === CourseStatus.published &&
      course.visibility === CourseVisibility.public &&
      course.moderationStatus === ModerationStatus.clear;
    const canManage = user ? this.canManageCourse(user, course) : false;

    if (!isPublic && !canManage) {
      throw new NotFoundException('Course not found');
    }

    const ratingByCourseId = await this.getCourseRatingAggregates([course.id]);
    return this.toCourseDetailResponse(
      course,
      ratingByCourseId.get(course.id),
    );
  }

  async enrollCourse(
    userId: string,
    courseId: string,
  ): Promise<SuccessResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const course = await tx.course.findFirst({
          where: {
            id: courseId,
            deletedAt: null,
            status: CourseStatus.published,
            moderationStatus: ModerationStatus.clear,
          },
          select: publishedCourseWithLessonsSelect,
        });

        if (!course) {
          throw new NotFoundException('Published course not found');
        }

        const existingEnrollment = await tx.enrollment.findFirst({
          where: {
            userId,
            courseId,
          },
          select: {
            id: true,
          },
        });

        if (existingEnrollment) {
          throw new ConflictException('Course already enrolled');
        }

        await tx.enrollment.create({
          data: {
            userId,
            courseId,
            status: ENROLLMENT_ACTIVE_STATUS,
          },
          select: {
            id: true,
          },
        });

        if (course.lessons.length > 0) {
          await tx.learningProgress.createMany({
            data: course.lessons.map((lesson) => ({
              userId,
              courseId,
              lessonId: lesson.id,
              status: PROGRESS_NOT_STARTED_STATUS,
              progressPercent: 0,
            })),
            skipDuplicates: true,
          });
        }

        return {
          success: true,
          message: 'Course enrolled successfully.',
        };
      });
    } catch (error) {
      if (this.isDuplicateEnrollmentError(error)) {
        throw new ConflictException('Course already enrolled');
      }

      throw error;
    }
  }

  async getMyEnrollments(userId: string): Promise<EnrollmentResponse[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        userId,
      },
      orderBy: {
        enrolledAt: 'desc',
      },
      select: buildEnrollmentResponseSelect(userId),
    });

    return enrollments.map((enrollment) =>
      this.toEnrollmentResponse(enrollment),
    );
  }

  async completeLesson(
    userId: string,
    lessonId: string,
  ): Promise<CourseProgressResponse> {
    return this.prisma.$transaction(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: {
          id: lessonId,
          deletedAt: null,
        },
        select: {
          id: true,
          courseId: true,
          course: {
            select: {
              id: true,
              ...courseLessonsSelect,
            },
          },
        },
      });

      if (!lesson) {
        throw new NotFoundException('Lesson not found');
      }

      const enrollment = await tx.enrollment.findFirst({
        where: {
          userId,
          courseId: lesson.courseId,
        },
        select: enrollmentSelect,
      });

      if (!enrollment) {
        throw new NotFoundException('Enrollment not found');
      }

      const progress = await this.calculateCourseProgress(
        tx,
        userId,
        lesson.courseId,
        lesson.course.lessons.map((courseLesson) => courseLesson.id),
      );

      if (!progress.completedLessonIds.includes(lessonId)) {
        throw new BadRequestException(
          'Lesson completion must be earned through lesson progress',
        );
      }

      const completion = await this.courseCompletionService.evaluateAndSync(
        tx,
        userId,
        lesson.courseId,
      );

      return { ...progress, completed: completion.completed };
    });
  }

  async getCourseProgress(
    userId: string,
    courseId: string,
  ): Promise<CourseProgressResponse> {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        userId,
        courseId,
      },
      select: {
        ...enrollmentSelect,
        course: {
          select: courseLessonsSelect,
        },
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    const progress = await this.calculateCourseProgress(
      this.prisma,
      userId,
      courseId,
      enrollment.course.lessons.map((lesson) => lesson.id),
    );
    return {
      ...progress,
      completed: enrollment.status === ENROLLMENT_COMPLETED_STATUS,
    };
  }

  private async findCourseOrThrow(courseId: string): Promise<ManageableCourse> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
      select: {
        ...manageableCourseSelect,
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private async deleteThumbnailBestEffort(key: string): Promise<void> {
    try {
      await this.thumbnailStorage.deleteThumbnail(key);
    } catch {
      // A failed cleanup must not roll back a successful database update.
    }
  }

  private async findCourseDetailOrThrow(
    courseId: string,
  ): Promise<CourseDetailRecord> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
      select: courseDetailSelect,
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private toCourseDetailResponse(
    course: CourseDetailRecord,
    rating?: CourseRatingAggregate,
  ): CourseDetailResponse {
    const catalog = this.toCourseCatalogResponse(course, rating);

    return {
      ...catalog,
      instructor: {
        ...catalog.instructor,
        bio: course.instructor.profile?.bio ?? null,
      },
      lessonCount: catalog.metrics.lessonCount,
    };
  }

  private toCourseCatalogResponse(
    course: CourseCatalogRecord,
    rating: CourseRatingAggregate = {
      ratingAverage: null,
      ratingCount: 0,
    },
  ): CourseCatalogResponse {
    return {
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      badge: course.badge,
      featuredRank: course.featuredRank,
      price:
        course.priceAmountMinor !== null && course.priceCurrency !== null
          ? {
              amountMinor: course.priceAmountMinor,
              currency: course.priceCurrency,
            }
          : null,
      level: course.level,
      status: course.status,
      visibility: course.visibility,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      instructor: {
        id: course.instructor.id,
        fullName: course.instructor.fullName,
        avatarUrl: course.instructor.avatarUrl,
        headline: course.instructor.profile?.headline ?? null,
      },
      metrics: {
        lessonCount: course._count.lessons,
        durationMinutes: course.lessons.reduce(
          (sum, lesson) => sum + (lesson.durationMinutes ?? 0),
          0,
        ),
        enrollmentCount: course._count.enrollments,
        ratingAverage: rating.ratingAverage,
        ratingCount: rating.ratingCount,
      },
    };
  }

  private async getCourseRatingAggregates(
    courseIds: string[],
  ): Promise<Map<string, CourseRatingAggregate>> {
    if (courseIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.courseReview.groupBy({
      by: ['courseId'],
      where: {
        courseId: {
          in: courseIds,
        },
      },
      _avg: {
        rating: true,
      },
      _count: {
        rating: true,
      },
    });

    return new Map(
      rows.map((row) => [
        row.courseId,
        {
          ratingAverage:
            row._avg.rating === null
              ? null
              : Math.round(row._avg.rating * 10) / 10,
          ratingCount: row._count.rating,
        },
      ]),
    );
  }

  private toEnrollmentResponse(
    enrollment: EnrollmentRecord,
  ): EnrollmentResponse {
    const lessons = enrollment.course.lessons;
    const completedLessons = lessons.filter((lesson) =>
      lesson.progress.some((progress) => progress.status === PROGRESS_COMPLETED_STATUS),
    ).length;
    const totalLessons = lessons.length;

    return {
      id: enrollment.id,
      courseId: enrollment.courseId,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
      course: {
        id: enrollment.course.id,
        title: enrollment.course.title,
        slug: enrollment.course.slug,
        description: enrollment.course.description,
        thumbnailUrl: enrollment.course.thumbnailUrl,
        level: enrollment.course.level,
        status: enrollment.course.status,
        visibility: enrollment.course.visibility,
        createdAt: enrollment.course.createdAt,
        updatedAt: enrollment.course.updatedAt,
      },
      progress: {
        completedLessons,
        totalLessons,
        progressPercent:
          totalLessons === 0
            ? 0
            : Math.round((completedLessons / totalLessons) * 100),
      },
    };
  }

  private async calculateCourseProgress(
    prisma: Pick<PrismaService, 'learningProgress'>,
    userId: string,
    courseId: string,
    lessonIds: string[],
  ): Promise<CourseProgressResponse> {
    const totalLessons = lessonIds.length;

    if (totalLessons === 0) {
      return {
        courseId,
        completedLessonIds: [],
        completedLessons: 0,
        totalLessons: 0,
        progressPercent: 0,
        completed: false,
      };
    }

    const progressRows = await prisma.learningProgress.findMany({
      where: {
        userId,
        courseId,
        lessonId: {
          in: lessonIds,
        },
      },
      select: {
        lessonId: true,
        status: true,
      },
    });
    const completedLessonIds = new Set(
      progressRows
        .filter((progress) => progress.status === PROGRESS_COMPLETED_STATUS)
        .map((progress) => progress.lessonId),
    );
    const completedLessons = completedLessonIds.size;
    const progressPercent = Math.round((completedLessons / totalLessons) * 100);

    return {
      courseId,
      completedLessonIds: [...completedLessonIds],
      completedLessons,
      totalLessons,
      progressPercent,
      completed: completedLessons === totalLessons,
    };
  }

  private assertCanCreateCourse(user: AuthenticatedUser): void {
    if (
      !this.hasRole(user, RoleName.instructor) &&
      !this.hasRole(user, RoleName.platform_admin)
    ) {
      throw new ForbiddenException('Only instructors or admins can create courses');
    }
  }

  private assertInstructor(user: AuthenticatedUser): void {
    if (!this.hasRole(user, RoleName.instructor)) {
      throw new ForbiddenException('Instructor role required');
    }
  }

  private assertCanManageCourse(
    user: AuthenticatedUser,
    course: Pick<ManageableCourse, 'instructorId'>,
  ): void {
    if (!this.canManageCourse(user, course)) {
      throw new NotFoundException('Course not found');
    }
  }

  private canManageCourse(
    user: AuthenticatedUser,
    course: Pick<ManageableCourse, 'instructorId'>,
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

  private assertValidPricePair(
    priceAmountMinor: number | null | undefined,
    priceCurrency: string | null | undefined,
  ): void {
    const hasAmount = priceAmountMinor !== null && priceAmountMinor !== undefined;
    const hasCurrency = priceCurrency !== null && priceCurrency !== undefined;

    if (hasAmount !== hasCurrency) {
      throw new BadRequestException(
        'priceAmountMinor and priceCurrency must be provided together',
      );
    }
  }

  private buildInstructorCoursesWhere(
    instructorId: string,
    query: Pick<ListInstructorCoursesQueryDto, 'search' | 'status'>,
  ): Prisma.CourseWhereInput {
    const search = query.search;

    return {
      instructorId,
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async createUniqueCourseSlug(title: string): Promise<string> {
    const normalized = title
      .trim()
      .toLowerCase()
      .replace(/đ/g, 'd')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = (normalized || 'course').slice(0, 120).replace(/-+$/g, '');

    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? '' : `-${index}`;
      const candidate = `${base
        .slice(0, 120 - suffix.length)
        .replace(/-+$/g, '')}${suffix}`;
      const existingCourse = await this.prisma.course.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!existingCourse) {
        return candidate;
      }
    }
  }

  private isCourseSlugConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('slug')
    );
  }

  private isDuplicateEnrollmentError(error: unknown): boolean {
    if (error instanceof ConflictException) {
      return false;
    }

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
