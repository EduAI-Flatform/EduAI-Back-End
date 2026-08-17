import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiEmbeddingService } from './ai-embedding.service';

const instructor: AuthenticatedUser = {
  id: 'instructor-id',
  roles: [RoleName.instructor],
};
const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };
const admin: AuthenticatedUser = { id: 'admin-id', roles: [RoleName.platform_admin] };

describe('AiEmbeddingService', () => {
  function createService() {
    const prisma = {
      lesson: { findFirst: jest.fn(), findMany: jest.fn() },
      libraryResource: { findFirst: jest.fn(), findMany: jest.fn() },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) => callback({
      $executeRaw: prisma.$executeRaw,
    }));
    const openai = {
      embed: jest.fn(),
      getEmbeddingModel: jest.fn().mockReturnValue('text-embedding-3-small'),
    };

    return {
      service: new AiEmbeddingService(prisma as never, openai as never),
      prisma,
      openai,
    };
  }

  it('embeds owned lesson text and stores source metadata', async () => {
    const { service, prisma, openai } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      id: 'lesson-id',
      title: 'Gradient descent',
      content: 'Gradient descent updates model weights.',
      course: { id: 'course-id', instructorId: instructor.id },
    });
    openai.embed.mockResolvedValue([[0.1, 0.2]]);

    await expect(service.embedLesson(instructor, 'lesson-id')).resolves.toEqual({
      sourceType: 'lesson',
      sourceId: 'lesson-id',
      chunkCount: 1,
    });
    expect(openai.embed).toHaveBeenCalledWith([
      'Gradient descent Gradient descent updates model weights.',
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not index a lesson for a non-owner student', async () => {
    const { service, prisma, openai } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      id: 'lesson-id',
      title: 'Private lesson',
      content: 'Private content',
      course: { id: 'course-id', instructorId: 'other-instructor' },
    });

    await expect(service.embedLesson(student, 'lesson-id')).rejects.toEqual(
      new NotFoundException('Lesson not found'),
    );
    expect(openai.embed).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('embeds an owned library resource description', async () => {
    const { service, prisma, openai } = createService();
    prisma.libraryResource.findFirst.mockResolvedValue({
      id: 'resource-id',
      ownerId: instructor.id,
      title: 'AI glossary',
      description: 'A short glossary of machine-learning terms.',
    });
    openai.embed.mockResolvedValue([[0.3]]);

    await service.embedLibraryResource(instructor, 'resource-id');

    expect(prisma.libraryResource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'resource-id', ownerId: instructor.id, deletedAt: null },
      }),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('rebuilds every active lesson and library resource for a platform admin', async () => {
    const { service, prisma, openai } = createService();
    prisma.lesson.findMany.mockResolvedValue([
      { id: 'lesson-id', title: 'Gradient descent', content: 'Updates weights.', course: { id: 'course-id' } },
    ]);
    prisma.libraryResource.findMany.mockResolvedValue([
      { id: 'resource-id', title: 'AI glossary', description: 'Core terms.' },
    ]);
    openai.embed.mockResolvedValue([[0.1, 0.2]]);

    await expect(service.rebuildAll(admin)).resolves.toEqual({
      lessons: 1,
      libraryResources: 1,
      chunkCount: 2,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it('does not permit non-admin users to rebuild embeddings', async () => {
    const { service, prisma } = createService();

    await expect(service.rebuildAll(instructor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });
});
