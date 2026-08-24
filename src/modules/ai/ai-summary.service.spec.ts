import { NotFoundException } from '@nestjs/common';
import { ModerationStatus, RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiSummaryService } from './ai-summary.service';

const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };

describe('AiSummaryService', () => {
  function createService() {
    const prisma = {
      lesson: { findFirst: jest.fn(), findUnique: jest.fn() },
      libraryResource: { findFirst: jest.fn() },
    };
    const completion = jest
      .fn()
      .mockResolvedValue({ content: 'A concise summary.' });
    const openai = {
      getModel: jest.fn().mockReturnValue('gpt-5.4-mini'),
      complete: completion,
    };
    const rateLimit = { assertSummaryAllowed: jest.fn() };
    const courseAccess = { decideContent: jest.fn().mockResolvedValue({ allowed: true }) };
    return { service: new AiSummaryService(prisma as never, openai as never, rateLimit as never, courseAccess as never), prisma, completion, rateLimit, courseAccess };
  }

  it('summarizes an accessible lesson with a stable response shape', async () => {
    const { service, prisma, completion, rateLimit } = createService();
    prisma.lesson.findFirst.mockResolvedValue({ id: 'lesson-id', courseId: 'course-id', isPreview: false });
    prisma.lesson.findUnique.mockResolvedValue({ title: 'Recursion', content: 'A function calls itself.' });

    await expect(service.summarize(student, { sourceType: 'lesson', sourceId: 'lesson-id' })).resolves.toEqual({
      sourceType: 'lesson', sourceId: 'lesson-id', title: 'Recursion', summary: 'A concise summary.',
    });
    expect(rateLimit.assertSummaryAllowed).toHaveBeenCalledWith(student.id);
    expect(prisma.lesson.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'lesson-id',
        }),
      }),
    );
    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Array) }),
    );
  });

  it('does not call the provider for an inaccessible resource', async () => {
    const { service, prisma, completion } = createService();
    prisma.libraryResource.findFirst.mockResolvedValue(null);

    await expect(service.summarize(student, { sourceType: 'library_resource', sourceId: 'resource-id' })).rejects.toEqual(
      new NotFoundException('AI summary source not found'),
    );
    expect(completion).not.toHaveBeenCalled();
    expect(prisma.libraryResource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { ownerId: student.id },
            {
              visibility: 'public',
              moderationStatus: ModerationStatus.clear,
            },
          ],
        }),
      }),
    );
  });
});
