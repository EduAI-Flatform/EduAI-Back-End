import { NotFoundException } from '@nestjs/common';
import { LearningProgressService } from './learning-progress.service';

const userId = 'student-id';
const courseId = 'course-id';
const lessonId = 'lesson-1';
const completedAt = new Date('2026-07-01T00:00:00.000Z');

const lesson = {
  id: lessonId,
  courseId,
  course: {
    id: courseId,
    lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
  },
};

const enrollment = {
  id: 'enrollment-id',
  userId,
  courseId,
  status: 'active',
  completedAt: null,
  course: {
    lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
  },
};

const progressRows = [
  {
    lessonId: 'lesson-1',
    status: 'completed',
    progressPercent: 100,
    completedAt,
    lastAccessedAt: completedAt,
  },
  {
    lessonId: 'lesson-2',
    status: 'not_started',
    progressPercent: 0,
    completedAt: null,
    lastAccessedAt: null,
  },
];

function createService(options?: {
  storedLesson?: typeof lesson | null;
  storedEnrollment?: typeof enrollment | null;
  progress?: typeof progressRows;
}) {
  let prisma: {
    $transaction: jest.Mock;
    lesson: { findFirst: jest.Mock };
    enrollment: { findFirst: jest.Mock; update: jest.Mock };
    learningProgress: { findMany: jest.Mock; upsert: jest.Mock };
  };

  prisma = {
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback(prisma),
    ),
    lesson: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options && 'storedLesson' in options ? options.storedLesson : lesson,
        ),
    },
    enrollment: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options && 'storedEnrollment' in options
            ? options.storedEnrollment
            : enrollment,
        ),
      update: jest.fn().mockResolvedValue(enrollment),
    },
    learningProgress: {
      findMany: jest.fn().mockResolvedValue(options?.progress ?? progressRows),
      upsert: jest.fn().mockResolvedValue(progressRows[0]),
    },
  };

  return {
    prisma,
    service: new LearningProgressService(prisma as never),
  };
}

describe('LearningProgressService', () => {
  it('completes a lesson for an enrolled student and returns course progress', async () => {
    const { prisma, service } = createService();

    await expect(service.completeLesson(userId, lessonId)).resolves.toEqual({
      courseId,
      completedLessonIds: ['lesson-1'],
      completedLessons: 1,
      totalLessons: 2,
      progressPercent: 50,
      completed: false,
    });

    expect(prisma.lesson.findFirst).toHaveBeenCalledWith({
      where: { id: lessonId, deletedAt: null },
      select: {
        id: true,
        courseId: true,
        course: {
          select: {
            id: true,
            lessons: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        },
      },
    });
    expect(prisma.enrollment.findFirst).toHaveBeenCalledWith({
      where: {
        userId,
        courseId,
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
      },
    });
    expect(prisma.learningProgress.upsert).toHaveBeenCalledWith({
      where: {
        userId_lessonId: {
          userId,
          lessonId,
        },
      },
      create: {
        userId,
        courseId,
        lessonId,
        status: 'completed',
        progressPercent: 100,
        completedAt: expect.any(Date),
        lastAccessedAt: expect.any(Date),
      },
      update: {
        status: 'completed',
        progressPercent: 100,
        completedAt: expect.any(Date),
        lastAccessedAt: expect.any(Date),
      },
    });
  });

  it('rejects lesson completion when the student is not enrolled', async () => {
    const { prisma, service } = createService({ storedEnrollment: null });

    await expect(service.completeLesson(userId, lessonId)).rejects.toEqual(
      new NotFoundException('Enrollment not found'),
    );
    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
  });

  it('marks the enrollment completed when all lessons are complete', async () => {
    const { prisma, service } = createService({
      progress: [
        { ...progressRows[0], lessonId: 'lesson-1' },
        { ...progressRows[0], lessonId: 'lesson-2' },
      ],
    });

    await expect(service.completeLesson(userId, lessonId)).resolves.toMatchObject({
      completedLessons: 2,
      totalLessons: 2,
      progressPercent: 100,
      completed: true,
    });
    expect(prisma.enrollment.update).toHaveBeenCalledWith({
      where: { id: enrollment.id },
      data: {
        status: 'completed',
        completedAt: expect.any(Date),
      },
    });
  });

  it('returns progress for an enrolled student without mutating lesson progress', async () => {
    const { prisma, service } = createService({
      progress: [{ ...progressRows[0], lessonId: 'lesson-2' }],
    });

    await expect(service.getCourseProgress(userId, courseId)).resolves.toEqual({
      courseId,
      completedLessonIds: ['lesson-2'],
      completedLessons: 1,
      totalLessons: 2,
      progressPercent: 50,
      completed: false,
    });

    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
    expect(prisma.lesson.findFirst).not.toHaveBeenCalled();
    expect(prisma.enrollment.findFirst).toHaveBeenCalledWith({
      where: {
        userId,
        courseId,
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        course: {
          select: {
            lessons: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        },
      },
    });
  });
});
