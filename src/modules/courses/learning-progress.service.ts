import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const PROGRESS_COMPLETED_STATUS = 'completed';
const ENROLLMENT_COMPLETED_STATUS = 'completed';

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

export interface CourseProgressResponse {
  courseId: string;
  completedLessonIds: string[];
  completedLessons: number;
  totalLessons: number;
  progressPercent: number;
  completed: boolean;
}

@Injectable()
export class LearningProgressService {
  constructor(private readonly prisma: PrismaService) {}

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
}
