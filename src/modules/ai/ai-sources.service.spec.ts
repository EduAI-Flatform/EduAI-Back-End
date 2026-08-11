import { ModerationStatus, RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiSourcesService } from './ai-sources.service';

const student: AuthenticatedUser = {
  id: 'student-id',
  roles: [RoleName.student],
};

describe('AiSourcesService', () => {
  function createService() {
    const prisma = {
      lesson: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'lesson-id',
            title: 'Gradient descent',
            course: { id: 'course-id', title: 'Machine Learning' },
          },
        ]),
      },
      libraryResource: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'resource-id',
            title: 'AI glossary',
            description: 'Key machine-learning terms.',
          },
        ]),
      },
    };

    return {
      prisma,
      service: new AiSourcesService(prisma as never),
    };
  }

  it('lists permitted lessons and library resources with picker-safe labels', async () => {
    const { service } = createService();

    await expect(service.listSources(student, {})).resolves.toEqual([
      {
        sourceType: 'library_resource',
        sourceId: 'resource-id',
        title: 'AI glossary',
        description: 'Key machine-learning terms.',
      },
      {
        sourceType: 'lesson',
        sourceId: 'lesson-id',
        title: 'Gradient descent',
        description: 'Machine Learning',
        courseId: 'course-id',
      },
    ]);
  });

  it('applies student authorization and search at the query boundary', async () => {
    const { service, prisma } = createService();

    await service.listSources(student, {
      sourceType: 'lesson',
      search: 'gradient',
    });

    expect(prisma.lesson.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          title: { contains: 'gradient', mode: 'insensitive' },
          OR: expect.arrayContaining([
            {
              isPreview: true,
              course: {
                status: 'published',
                visibility: 'public',
                moderationStatus: ModerationStatus.clear,
              },
            },
            {
              course: {
                enrollments: {
                  some: {
                    userId: student.id,
                    status: { in: ['active', 'completed'] },
                  },
                },
              },
            },
          ]),
        }),
        take: 50,
      }),
    );
    expect(prisma.libraryResource.findMany).not.toHaveBeenCalled();
  });

  it('allows owned library sources but requires clear moderation for public sources', async () => {
    const { service, prisma } = createService();

    await service.listSources(student, { sourceType: 'library_resource' });

    expect(prisma.libraryResource.findMany).toHaveBeenCalledWith(
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
