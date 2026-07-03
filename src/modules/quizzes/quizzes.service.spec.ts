import { NotFoundException } from '@nestjs/common';
import { QuestionType, QuizStatus, RoleName } from '../../../generated/prisma/client';
import { QuizzesService } from './quizzes.service';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const otherInstructor = { id: 'other-instructor-id', roles: [RoleName.instructor] };

const course = { id: 'course-id', instructorId: instructor.id };
const quiz = {
  id: 'quiz-id',
  courseId: course.id,
  lessonId: null,
  title: 'Quiz nền tảng AI',
  description: null,
  passingScore: 70,
  timeLimitMinutes: 30,
  status: QuizStatus.draft,
  createdAt: new Date('2026-07-02T00:00:00.000Z'),
  updatedAt: new Date('2026-07-02T00:00:00.000Z'),
};

function createService() {
  const prisma = {
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    lesson: { findFirst: jest.fn() },
    quiz: {
      create: jest.fn().mockResolvedValue(quiz),
      findFirst: jest.fn().mockResolvedValue({ ...quiz, course }),
      findMany: jest.fn().mockResolvedValue([quiz]),
      update: jest.fn().mockResolvedValue(quiz),
    },
    question: {
      create: jest.fn().mockResolvedValue({
        id: 'question-id',
        quizId: quiz.id,
        type: QuestionType.multiple_choice,
        questionText: 'AI là gì?',
        optionsJson: ['A', 'B'],
        correctAnswerJson: 'A',
        explanation: null,
        points: 1,
        orderIndex: 1,
        createdAt: quiz.createdAt,
        updatedAt: quiz.updatedAt,
      }),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  return { prisma, service: new QuizzesService(prisma as never) };
}

describe('QuizzesService', () => {
  it('creates quizzes as drafts for an owned course', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createQuiz(instructor, course.id, {
        title: quiz.title,
        passingScore: quiz.passingScore,
        timeLimitMinutes: quiz.timeLimitMinutes,
      }),
    ).resolves.toEqual(quiz);

    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: { id: course.id, deletedAt: null },
      select: { id: true, instructorId: true },
    });
    expect(prisma.quiz.create).toHaveBeenCalledWith({
      data: {
        courseId: course.id,
        lessonId: undefined,
        title: quiz.title,
        description: undefined,
        passingScore: quiz.passingScore,
        timeLimitMinutes: quiz.timeLimitMinutes,
        status: QuizStatus.draft,
      },
      select: expect.any(Object),
    });
  });

  it('hides courses owned by another instructor', async () => {
    const { service } = createService();

    await expect(
      service.createQuiz(otherInstructor, course.id, {
        title: quiz.title,
        passingScore: 70,
      }),
    ).rejects.toEqual(new NotFoundException('Course not found'));
  });

  it('publishes an owned draft quiz', async () => {
    const { prisma, service } = createService();
    prisma.quiz.update.mockResolvedValue({ ...quiz, status: QuizStatus.published });

    await expect(service.publishQuiz(instructor, quiz.id)).resolves.toMatchObject({
      status: QuizStatus.published,
    });
    expect(prisma.quiz.update).toHaveBeenCalledWith({
      where: { id: quiz.id },
      data: { status: QuizStatus.published },
      select: expect.any(Object),
    });
  });

  it('creates question JSON fields under an owned quiz', async () => {
    const { prisma, service } = createService();
    const input = {
      type: QuestionType.multiple_choice,
      questionText: 'AI là gì?',
      optionsJson: ['A', 'B'],
      correctAnswerJson: 'A',
      points: 1,
      orderIndex: 1,
    };

    await service.createQuestion(instructor, quiz.id, input);

    expect(prisma.question.create).toHaveBeenCalledWith({
      data: { quizId: quiz.id, explanation: undefined, ...input },
      select: expect.any(Object),
    });
  });
});
