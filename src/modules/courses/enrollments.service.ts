import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CourseStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const ENROLLMENT_ACTIVE_STATUS = 'active';
const PROGRESS_NOT_STARTED_STATUS = 'not_started';

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

@Injectable()
export class EnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async enrollCourse(
    userId: string,
    courseId: string,
  ): Promise<EnrollmentResponse> {
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

        const enrollment = await tx.enrollment.create({
          data: {
            userId,
            courseId,
            status: ENROLLMENT_ACTIVE_STATUS,
          },
          select: buildEnrollmentResponseSelect(userId),
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

        return this.toEnrollmentResponse(enrollment);
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

  private toEnrollmentResponse(
    enrollment: EnrollmentRecord,
  ): EnrollmentResponse {
    const lessons = enrollment.course.lessons;
    const completedLessons = lessons.filter((lesson) =>
      lesson.progress.some((progress) => progress.status === 'completed'),
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
