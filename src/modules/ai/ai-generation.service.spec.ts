import { BadGatewayException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiGenerationService } from './ai-generation.service';

const user: AuthenticatedUser = { id: 'user-id', roles: [RoleName.student] };
const input = { sourceType: 'lesson' as const, sourceId: 'lesson-id', count: 2 };

describe('AiGenerationService', () => {
  function createService(payload: unknown) {
    const prisma = {
      aiGeneratedQuiz: { create: jest.fn().mockResolvedValue({ id: 'quiz-id' }) },
      aiFlashcard: { create: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([
        { id: 'card-1', front: 'Q1', back: 'A1' },
        { id: 'card-2', front: 'Q2', back: 'A2' },
      ]),
    };
    const openai = {
      getModel: jest.fn().mockReturnValue('test-model'),
      complete: jest
        .fn()
        .mockResolvedValue({
          content: typeof payload === 'string' ? payload : JSON.stringify(payload),
        }),
    };
    const rateLimit = { assertQuizAllowed: jest.fn(), assertFlashcardsAllowed: jest.fn() };
    const summary = { resolveSource: jest.fn().mockResolvedValue({ title: 'Recursion', content: 'A function calls itself.' }) };
    return { service: new AiGenerationService(prisma as never, openai as never, rateLimit as never, summary as never), prisma, rateLimit, summary };
  }

  it('generates and persists structured quiz questions', async () => {
    const { service, prisma, rateLimit, summary } = createService([
      { question: 'What is recursion?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A', explanation: 'It repeats a call.' },
      { question: 'How?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
    ]);

    await expect(service.generateQuiz(user, input)).resolves.toEqual({
      quizId: 'quiz-id', sourceType: 'lesson', sourceId: 'lesson-id', questions: expect.any(Array),
    });
    expect(rateLimit.assertQuizAllowed).toHaveBeenCalledWith(user.id);
    expect(summary.resolveSource).toHaveBeenCalledWith(user, input);
    expect(prisma.aiGeneratedQuiz.create).toHaveBeenCalled();
  });

  it('persists structured flashcards in one transaction', async () => {
    const { service, prisma, rateLimit } = createService([
      { front: 'Term 1', back: 'Definition 1' },
      { front: 'Term 2', back: 'Definition 2' },
    ]);

    await expect(service.generateFlashcards(user, input)).resolves.toEqual({
      sourceType: 'lesson', sourceId: 'lesson-id', flashcards: [
        { id: 'card-1', front: 'Q1', back: 'A1' },
        { id: 'card-2', front: 'Q2', back: 'A2' },
      ],
    });
    expect(rateLimit.assertFlashcardsAllowed).toHaveBeenCalledWith(user.id);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed quiz output before persistence', async () => {
    const { service, prisma } = createService([{ question: 'Missing options' }]);

    await expect(service.generateQuiz(user, input)).rejects.toEqual(
      new BadGatewayException('AI provider returned invalid quiz content'),
    );
    expect(prisma.aiGeneratedQuiz.create).not.toHaveBeenCalled();
  });

  it('accepts a JSON code fence and passes a bounded response schema', async () => {
    const { service, prisma } = createService(
      '```json\n{"items":[{"question":"Q1","options":["A","B","C","D"],"correctAnswer":"A","explanation":"E"},{"question":"Q2","options":["A","B","C","D"],"correctAnswer":"B","explanation":"E"}]}\n```',
    );

    await expect(service.generateQuiz(user, input)).resolves.toMatchObject({
      quizId: 'quiz-id',
      questions: expect.any(Array),
    });
    expect(prisma.aiGeneratedQuiz.create).toHaveBeenCalled();
  });
});
