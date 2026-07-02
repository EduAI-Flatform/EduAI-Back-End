import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QuestionType, QuizStatus } from '../../../generated/prisma/client';
import { QuizAttemptsService } from './quiz-attempts.service';

const userId = 'student-id';
const quizId = 'quiz-id';
const submittedAt = new Date('2026-07-02T00:00:00.000Z');
const quiz = {
  id: quizId,
  passingScore: 70,
  status: QuizStatus.published,
  questions: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      type: QuestionType.multiple_choice,
      correctAnswerJson: 'A',
      points: 2,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      type: QuestionType.true_false,
      correctAnswerJson: true,
      points: 1,
    },
  ],
};

function createService(storedQuiz: typeof quiz | null = quiz) {
  const attempt = {
    id: 'attempt-id',
    quizId,
    score: 2,
    maxScore: 3,
    passed: false,
    startedAt: submittedAt,
    submittedAt,
    createdAt: submittedAt,
  };
  const prisma = {
    quiz: { findFirst: jest.fn().mockResolvedValue(storedQuiz) },
    quizAttempt: {
      create: jest.fn().mockResolvedValue(attempt),
      findMany: jest.fn().mockResolvedValue([attempt]),
    },
  };
  return { attempt, prisma, service: new QuizAttemptsService(prisma as never) };
}

describe('QuizAttemptsService', () => {
  it('scores weighted objective answers, stores the attempt, and calculates passed', async () => {
    const { prisma, service } = createService();
    const answers = [
      { questionId: quiz.questions[0].id, answer: ' a ' },
      { questionId: quiz.questions[1].id, answer: false },
    ];

    await expect(service.submitAttempt(userId, quizId, { answers })).resolves.toEqual(
      expect.objectContaining({
        id: 'attempt-id',
        quizId,
        score: 2,
        maxScore: 3,
        passed: false,
      }),
    );
    expect(prisma.quizAttempt.create).toHaveBeenCalledWith({
      data: {
        quizId,
        userId,
        score: 2,
        maxScore: 3,
        passed: false,
        answersJson: answers,
        startedAt: expect.any(Date),
        submittedAt: expect.any(Date),
      },
      select: expect.not.objectContaining({ answersJson: true }),
    });
  });

  it('rejects duplicate or incomplete answer sets', async () => {
    const { service } = createService();

    await expect(
      service.submitAttempt(userId, quizId, {
        answers: [
          { questionId: quiz.questions[0].id, answer: 'A' },
          { questionId: quiz.questions[0].id, answer: 'A' },
        ],
      }),
    ).rejects.toEqual(new BadRequestException('Each quiz question must be answered once'));
  });

  it('hides unpublished, missing, or unenrolled quizzes', async () => {
    const { service } = createService(null);

    await expect(
      service.submitAttempt(userId, quizId, { answers: [] }),
    ).rejects.toEqual(new NotFoundException('Quiz not found'));
  });

  it('lists only attempts belonging to the authenticated student', async () => {
    const { prisma, service } = createService();

    await service.listMyAttempts(userId, quizId);

    expect(prisma.quizAttempt.findMany).toHaveBeenCalledWith({
      where: { quizId, userId },
      orderBy: { createdAt: 'desc' },
      select: expect.not.objectContaining({ answersJson: true }),
    });
  });
});
