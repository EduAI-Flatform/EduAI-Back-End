import { NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { LearningPathService } from './learning-path.service';

const student = { id: 'student-1', roles: [RoleName.student] } as never;

function createFixture() {
  const course: any = {
    id: 'course-1',
    lessons: [
      {
        id: 'lesson-1',
        title: 'Video đầu tiên',
        type: 'video',
        orderIndex: 1,
        isPreview: false,
        isRequired: true,
        progress: [],
      },
      {
        id: 'lesson-2',
        title: 'Video tiếp theo',
        type: 'video',
        orderIndex: 2,
        isPreview: false,
        isRequired: true,
        progress: [],
      },
    ],
    assignments: [],
    quizzes: [],
  };

  const tx = {
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    lesson: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lesson-1',
        courseId: 'course-1',
        type: 'video',
        durationMinutes: 2,
      }),
    },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue({ id: 'enrollment-1' }),
      updateMany: jest.fn(),
    },
    learningProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(async ({ create }) => {
        const lesson = course.lessons.find((item: any) => item.id === create.lessonId);
        if (lesson) lesson.progress = [create];
        return create;
      }),
    },
  };

  const prisma = {
    ...tx,
    assignment: { findFirst: jest.fn() },
    quiz: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const completionService = {
    evaluateAndSync: jest.fn().mockResolvedValue({
      completed: false,
      completedRequiredItems: 0,
      totalRequiredItems: 2,
      enrollmentUpdated: false,
    }),
  };

  return {
    completionService,
    course,
    prisma: prisma as never,
    tx,
    service: new LearningPathService(
      prisma as never,
      completionService as never,
    ),
  };
}

describe('LearningPathService', () => {
  it('does not complete a video when the learner only seeks to the end', async () => {
    const { completionService, service, tx } = createFixture();

    const result = await service.updateLessonProgress(student, 'lesson-1', {
      durationSeconds: 120,
      watchedSeconds: 120,
      lastPositionSeconds: 120,
    });

    expect(result.progressPercent).toBe(0);
    expect(result.completed).toBe(false);
    expect(result.steps[0].status).toBe('AVAILABLE');
    expect(completionService.evaluateAndSync).toHaveBeenCalledWith(
      tx,
      'student-1',
      'course-1',
    );
  });

  it('rejects direct access to a lesson that is still locked', async () => {
    const { service } = createFixture();

    await expect(service.assertLessonAccessible(student, 'lesson-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
