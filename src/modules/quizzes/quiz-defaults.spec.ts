import { ForbiddenException } from '@nestjs/common';
import { QuizzesService } from './quizzes.service';

describe('administrator quiz defaults', () => {
  const policy = { passingScore: 85, timeLimitMinutes: 20, maxAttempts: 2, randomizeQuestions: true,
    randomizeOptions: true, showCorrectAnswers: false, isRequired: false, allowInstructorOverrides: false };
  function setup(overrides = {}) {
    const prisma = { course: { findFirst: jest.fn().mockResolvedValue({ id: 'course', instructorId: 'teacher' }) },
      quiz: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
        findFirst: jest.fn().mockResolvedValue({ id: 'quiz', courseId: 'course', course: { instructorId: 'teacher' },
          passingScore: 65, timeLimitMinutes: null, maxAttempts: 4, randomizeQuestions: false, randomizeOptions: false,
          showCorrectAnswers: true, isRequired: true }), update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) } };
    const settings = { current: jest.fn().mockResolvedValue({ settings: { courses: { quizDefaults: { ...policy, ...overrides } } } }) };
    return { prisma, settings, service: Reflect.construct(QuizzesService, [prisma, {}, {}, {}, undefined, settings]) as QuizzesService };
  }
  it('uses the effective administrator defaults when creation fields are omitted', async () => {
    const { service } = setup();
    await expect(service.createQuiz({ id: 'teacher', roles: ['instructor'] } as never, 'course', { title: 'New quiz' } as never))
      .resolves.toMatchObject({ passingScore: 85, timeLimitMinutes: 20, maxAttempts: 2, randomizeQuestions: true,
        randomizeOptions: true, showCorrectAnswers: false, isRequired: false });
  });
  it('rejects a teacher override through the API while allowing matching effective values', async () => {
    const { service, prisma } = setup(); const teacher = { id: 'teacher', roles: ['instructor'] } as never;
    await expect(service.createQuiz(teacher, 'course', { title: 'New quiz', passingScore: 70 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.quiz.create).not.toHaveBeenCalled();
    await expect(service.createQuiz(teacher, 'course', { title: 'New quiz', passingScore: 85 })).resolves.toMatchObject({ passingScore: 85 });
  });
  it('allows explicit Admin overrides and permitted instructor unlimited options', async () => {
    const { service } = setup();
    await expect(service.createQuiz({ id: 'teacher', roles: ['platform_admin'] } as never, 'course',
      { title: 'Admin quiz', passingScore: 50, maxAttempts: null })).resolves.toMatchObject({ passingScore: 50, maxAttempts: null });
    const allowed = setup({ allowInstructorOverrides: true });
    await expect(allowed.service.createQuiz({ id: 'teacher', roles: ['instructor'] } as never, 'course',
      { title: 'Teacher quiz', passingScore: 75, maxAttempts: null, timeLimitMinutes: null } as never))
      .resolves.toMatchObject({ passingScore: 75, maxAttempts: null, timeLimitMinutes: null });
  });
  it('preserves historical quiz values on title-only edits and rejects protected value changes', async () => {
    const { service, prisma } = setup(); const teacher = { id: 'teacher', roles: ['instructor'] } as never;
    await expect(service.updateQuiz(teacher, 'quiz', { title: 'Renamed' })).resolves.toEqual({ title: 'Renamed' });
    await expect(service.updateQuiz(teacher, 'quiz', { passingScore: 85 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.quiz.update).toHaveBeenCalledTimes(1);
  });
});
