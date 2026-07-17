import { NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiSummaryService } from './ai-summary.service';

const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };

describe('AiSummaryService', () => {
  function createService() {
    const prisma = {
      lesson: { findFirst: jest.fn() },
      libraryResource: { findFirst: jest.fn() },
    };
    const completion = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'A concise summary.' } }],
    });
    const openai = {
      getModel: jest.fn().mockReturnValue('gpt-5.4-mini'),
      getClient: jest.fn().mockReturnValue({ chat: { completions: { create: completion } } }),
    };
    const rateLimit = { assertSummaryAllowed: jest.fn() };
    return { service: new AiSummaryService(prisma as never, openai as never, rateLimit as never), prisma, completion, rateLimit };
  }

  it('summarizes an accessible lesson with a stable response shape', async () => {
    const { service, prisma, completion, rateLimit } = createService();
    prisma.lesson.findFirst.mockResolvedValue({ id: 'lesson-id', title: 'Recursion', content: 'A function calls itself.' });

    await expect(service.summarize(student, { sourceType: 'lesson', sourceId: 'lesson-id' })).resolves.toEqual({
      sourceType: 'lesson', sourceId: 'lesson-id', title: 'Recursion', summary: 'A concise summary.',
    });
    expect(rateLimit.assertSummaryAllowed).toHaveBeenCalledWith(student.id);
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4-mini' }));
  });

  it('does not call the provider for an inaccessible resource', async () => {
    const { service, prisma, completion } = createService();
    prisma.libraryResource.findFirst.mockResolvedValue(null);

    await expect(service.summarize(student, { sourceType: 'library_resource', sourceId: 'resource-id' })).rejects.toEqual(
      new NotFoundException('AI summary source not found'),
    );
    expect(completion).not.toHaveBeenCalled();
  });
});
