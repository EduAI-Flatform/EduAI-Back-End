import { BadRequestException, NotFoundException } from '@nestjs/common';
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
const attemptQuiz = {
  id: quiz.id,
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
const submittedAt = new Date('2026-07-02T00:00:00.000Z');

function createService(storedAttemptQuiz: typeof attemptQuiz | null = attemptQuiz) {
  const attempt = {
    id: 'attempt-id',
    quizId: quiz.id,
    score: 2,
    maxScore: 3,
    passed: false,
    startedAt: submittedAt,
    submittedAt,
    createdAt: submittedAt,
  };
  const prisma = {
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    lesson: { findFirst: jest.fn() },
    quiz: {
      create: jest.fn().mockResolvedValue(quiz),
      findFirst: jest.fn().mockImplementation((args) => {
        if (args?.select?.questions) {
          return Promise.resolve(storedAttemptQuiz);
        }

        return Promise.resolve({ ...quiz, course });
      }),
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
    quizAttempt: {
      create: jest.fn().mockResolvedValue(attempt),
      findMany: jest.fn().mockResolvedValue([attempt]),
    },
  };

  return { attempt, prisma, service: new QuizzesService(prisma as never) };
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

  it('scores weighted objective answers, stores the attempt, and calculates passed', async () => {
    const { prisma, service } = createService();
    const answers = [
      { questionId: attemptQuiz.questions[0].id, answer: ' a ' },
      { questionId: attemptQuiz.questions[1].id, answer: false },
    ];

    await expect(service.submitAttempt('student-id', quiz.id, { answers })).resolves.toEqual(
      expect.objectContaining({
        id: 'attempt-id',
        quizId: quiz.id,
        score: 2,
        maxScore: 3,
        passed: false,
      }),
    );
    expect(prisma.quizAttempt.create).toHaveBeenCalledWith({
      data: {
        quizId: quiz.id,
        userId: 'student-id',
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
      service.submitAttempt('student-id', quiz.id, {
        answers: [
          { questionId: attemptQuiz.questions[0].id, answer: 'A' },
          { questionId: attemptQuiz.questions[0].id, answer: 'A' },
        ],
      }),
    ).rejects.toEqual(new BadRequestException('Each quiz question must be answered once'));
  });

  it('hides unpublished, missing, or unenrolled quizzes', async () => {
    const { service } = createService(null);

    await expect(
      service.submitAttempt('student-id', quiz.id, { answers: [] }),
    ).rejects.toEqual(new NotFoundException('Quiz not found'));
  });

  it('lists only attempts belonging to the authenticated student', async () => {
    const { prisma, service } = createService();

    await service.listMyAttempts('student-id', quiz.id);

    expect(prisma.quizAttempt.findMany).toHaveBeenCalledWith({
      where: { quizId: quiz.id, userId: 'student-id' },
      orderBy: { createdAt: 'desc' },
      select: expect.not.objectContaining({ answersJson: true }),
    });
  });
});
