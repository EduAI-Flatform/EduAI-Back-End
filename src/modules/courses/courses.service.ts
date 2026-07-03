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
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCourseDto } from './dto/create-course.dto';
import { ListInstructorCoursesQueryDto } from './dto/list-instructor-courses-query.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

const courseResponseSelect = {
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

const courseCommandResponseSelect = {
  id: true,
  status: true,
} satisfies Prisma.CourseSelect;

const ENROLLMENT_ACTIVE_STATUS = 'active';
const ENROLLMENT_COMPLETED_STATUS = 'completed';
const PROGRESS_NOT_STARTED_STATUS = 'not_started';
const PROGRESS_COMPLETED_STATUS = 'completed';

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

export type CourseCommandResponse = Prisma.CourseGetPayload<{
  select: typeof courseCommandResponseSelect;
}>;

export type CourseDetailResponse = CourseResponse & {
  lessonCount: number;
};

export interface PaginatedCourseResponse {
  items: CourseResponse[];
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

type ManageableCourse = CourseResponse & {
  instructorId: string;
  _count: { lessons: number };
};

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async listCourses(): Promise<CourseResponse[]> {
    return this.prisma.course.findMany({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: courseResponseSelect,
    });
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
        select: courseResponseSelect,
      }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async createCourse(
    user: AuthenticatedUser,
    input: CreateCourseDto,
  ): Promise<CourseCommandResponse> {
    this.assertCanCreateCourse(user);

    try {
      return await this.prisma.course.create({
        data: {
          instructorId: user.id,
          title: input.title,
          slug: input.slug,
          description: input.description,
          thumbnailUrl: input.thumbnailUrl,
          level: input.level,
          status: CourseStatus.draft,
          visibility: input.visibility ?? CourseVisibility.public,
        },
        select: courseCommandResponseSelect,
      });
    } catch (error) {
      if (this.isCourseSlugConflict(error)) {
        throw new ConflictException('Course slug is already in use');
      }

      throw error;
    }
  }

  async updateCourse(
    user: AuthenticatedUser,
    courseId: string,
    input: UpdateCourseDto,
  ): Promise<CourseCommandResponse> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    if (input.status !== undefined) {
      throw new BadRequestException(
        'Use publish or archive course endpoints to change status',
      );
    }

    const data = this.removeUndefinedFields({
      title: input.title,
      slug: input.slug,
      description: input.description,
      thumbnailUrl: input.thumbnailUrl,
      level: input.level,
      visibility: input.visibility,
    });

    try {
      return await this.prisma.course.update({
        where: { id: courseId },
        data,
        select: courseCommandResponseSelect,
      });
    } catch (error) {
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

    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.published,
      },
      select: courseCommandResponseSelect,
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
    const course = await this.findCourseOrThrow(courseId);

    if (
      course.status === CourseStatus.published &&
      course.visibility === CourseVisibility.public
    ) {
      return this.toCourseDetailResponse(course);
    }

    if (user && this.canManageCourse(user, course)) {
      return this.toCourseDetailResponse(course);
    }

    throw new NotFoundException('Course not found');
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

      const now = new Date();

      await tx.learningProgress.upsert({
        where: {
          userId_lessonId: {
            userId,
            lessonId,
          },
        },
        create: {
          userId,
          courseId: lesson.courseId,
          lessonId,
          status: PROGRESS_COMPLETED_STATUS,
          progressPercent: 100,
          completedAt: now,
          lastAccessedAt: now,
        },
        update: {
          status: PROGRESS_COMPLETED_STATUS,
          progressPercent: 100,
          completedAt: now,
          lastAccessedAt: now,
        },
      });

      const progress = await this.calculateCourseProgress(
        tx,
        userId,
        lesson.courseId,
        lesson.course.lessons.map((courseLesson) => courseLesson.id),
      );

      if (progress.completed && !enrollment.completedAt) {
        await tx.enrollment.update({
          where: {
            id: enrollment.id,
          },
          data: {
            status: ENROLLMENT_COMPLETED_STATUS,
            completedAt: now,
          },
        });
      }

      return progress;
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

    return this.calculateCourseProgress(
      this.prisma,
      userId,
      courseId,
      enrollment.course.lessons.map((lesson) => lesson.id),
    );
  }

  private async findCourseOrThrow(courseId: string): Promise<ManageableCourse> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
      select: {
        ...courseResponseSelect,
        instructorId: true,
        _count: {
          select: {
            lessons: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private toCourseDetailResponse(course: ManageableCourse): CourseDetailResponse {
    return {
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      level: course.level,
      status: course.status,
      visibility: course.visibility,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      lessonCount: course._count.lessons,
    };
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
