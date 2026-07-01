import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  LessonType,
} from '../../../generated/prisma/client';
import { EnrollmentsService } from './enrollments.service';

const userId = 'student-id';
const courseId = 'course-id';

const lesson = {
  id: 'lesson-id',
  orderIndex: 1,
};

const course = {
  id: courseId,
  title: 'AI Foundations',
  slug: 'ai-foundations',
  description: null,
  thumbnailUrl: null,
  level: CourseLevel.beginner,
  status: CourseStatus.published,
  visibility: CourseVisibility.public,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  lessons: [lesson],
};

const enrollment = {
  id: 'enrollment-id',
  userId,
  courseId,
  status: 'active',
  enrolledAt: new Date('2026-07-01T00:00:00.000Z'),
  completedAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  course: {
    id: courseId,
    title: 'AI Foundations',
    slug: 'ai-foundations',
    description: null,
    thumbnailUrl: null,
    level: CourseLevel.beginner,
    status: CourseStatus.published,
    visibility: CourseVisibility.public,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    lessons: [
      {
        id: 'lesson-id',
        title: 'Introduction',
        slug: 'introduction',
        type: LessonType.video,
        orderIndex: 1,
        durationMinutes: 10,
        isPreview: false,
        progress: [{ status: 'not_started', progressPercent: 0 }],
      },
    ],
  },
};

function createService(options?: {
  storedCourse?: typeof course | null;
  existingEnrollment?: { id: string } | null;
}) {
  let prisma: {
    $transaction: jest.Mock;
    course: { findFirst: jest.Mock };
    enrollment: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    learningProgress: { createMany: jest.Mock };
  };

  prisma = {
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback(prisma),
    ),
    course: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options && 'storedCourse' in options ? options.storedCourse : course,
        ),
    },
    enrollment: {
      create: jest.fn().mockResolvedValue(enrollment),
      findFirst: jest
        .fn()
        .mockResolvedValue(options?.existingEnrollment ?? null),
      findMany: jest.fn().mockResolvedValue([enrollment]),
    },
    learningProgress: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return {
    prisma,
    service: new EnrollmentsService(prisma as never),
  };
}

describe('EnrollmentsService', () => {
  it('enrolls users in published courses and initializes lesson progress', async () => {
    const { prisma, service } = createService();

    await expect(service.enrollCourse(userId, courseId)).resolves.toMatchObject({
      id: enrollment.id,
      courseId,
      status: 'active',
      course: {
        id: courseId,
        title: 'AI Foundations',
      },
      progress: {
        completedLessons: 0,
        totalLessons: 1,
        progressPercent: 0,
      },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: {
        id: courseId,
        deletedAt: null,
        status: CourseStatus.published,
      },
      select: {
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
        lessons: {
          where: { deletedAt: null },
          orderBy: { orderIndex: 'asc' },
          select: { id: true, orderIndex: true },
        },
      },
    });
    expect(prisma.enrollment.create).toHaveBeenCalledWith({
      data: {
        userId,
        courseId,
        status: 'active',
      },
      select: expect.any(Object),
    });
    expect(prisma.learningProgress.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId,
          courseId,
          lessonId: lesson.id,
          status: 'not_started',
          progressPercent: 0,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('rejects enrollment for missing or unpublished courses', async () => {
    const { prisma, service } = createService({ storedCourse: null });

    await expect(service.enrollCourse(userId, courseId)).rejects.toEqual(
      new NotFoundException('Published course not found'),
    );
    expect(prisma.enrollment.create).not.toHaveBeenCalled();
    expect(prisma.learningProgress.createMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate enrollment', async () => {
    const { prisma, service } = createService({
      existingEnrollment: { id: enrollment.id },
    });

    await expect(service.enrollCourse(userId, courseId)).rejects.toEqual(
      new ConflictException('Course already enrolled'),
    );
    expect(prisma.enrollment.create).not.toHaveBeenCalled();
    expect(prisma.learningProgress.createMany).not.toHaveBeenCalled();
  });

  it('lists authenticated user enrollments with lean course and progress data', async () => {
    const { prisma, service } = createService();

    await expect(service.getMyEnrollments(userId)).resolves.toEqual([
      {
        id: enrollment.id,
        courseId,
        status: 'active',
        enrolledAt: enrollment.enrolledAt,
        completedAt: null,
        course: {
          id: courseId,
          title: 'AI Foundations',
          slug: 'ai-foundations',
          description: null,
          thumbnailUrl: null,
          level: CourseLevel.beginner,
          status: CourseStatus.published,
          visibility: CourseVisibility.public,
          createdAt: enrollment.course.createdAt,
          updatedAt: enrollment.course.updatedAt,
        },
        progress: {
          completedLessons: 0,
          totalLessons: 1,
          progressPercent: 0,
        },
      },
    ]);
    expect(prisma.enrollment.findMany).toHaveBeenCalledWith({
      where: { userId },
      orderBy: { enrolledAt: 'desc' },
      select: expect.any(Object),
    });
  });
});
