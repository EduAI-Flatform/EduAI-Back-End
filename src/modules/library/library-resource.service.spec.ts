import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LibraryResourceService } from './library-resource.service';
import { CourseVisibility, Prisma, RoleName } from '../../../generated/prisma/client';

const resource = {
  id: 'resource-id',
  ownerId: 'owner-id',
  categoryId: 'category-id',
  title: 'TypeScript',
  description: null,
  type: 'pdf',
  fileUrl: 'https://cdn.example.com/documents/resource.pdf',
  externalUrl: null,
  visibility: 'public',
  createdAt: new Date('2026-07-16T00:00:00.000Z'),
  updatedAt: new Date('2026-07-16T00:00:00.000Z'),
  category: { id: 'category-id', name: 'Programming', slug: 'programming' },
  tags: [],
};

function createService() {
  const prisma = {
    $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    libraryCategory: {
      findUnique: jest.fn().mockResolvedValue({ id: 'category-id' }),
    },
    libraryTag: {
      findMany: jest.fn().mockResolvedValue([{ id: 'tag-id' }]),
    },
    libraryResource: {
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue(resource),
      findFirst: jest.fn().mockResolvedValue({ id: resource.id }),
      findMany: jest.fn().mockResolvedValue([resource]),
    },
    savedResource: {
      create: jest.fn().mockResolvedValue({ id: 'saved-id' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([{ resource }]),
    },
  };
  const storage = {
    uploadResource: jest.fn().mockResolvedValue({
      key: 'documents/generated.pdf',
      url: resource.fileUrl,
    }),
  };

  return {
    prisma,
    storage,
    service: new LibraryResourceService(prisma as never, storage as never),
  };
}

describe('LibraryResourceService', () => {
  it('creates one favorite for an accessible resource', async () => {
    const { prisma, service } = createService();

    await expect(
      service.favoriteResource('student-id', [RoleName.student], resource.id),
    ).resolves.toEqual({ success: true, message: 'Resource added to favorites' });

    expect(prisma.savedResource.create).toHaveBeenCalledWith({
      data: { userId: 'student-id', resourceId: resource.id },
    });
  });

  it('maps the unique favorite constraint to a conflict', async () => {
    const { prisma, service } = createService();
    prisma.savedResource.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
        meta: { target: ['user_id', 'resource_id'] },
      }),
    );

    await expect(
      service.favoriteResource('student-id', [RoleName.student], resource.id),
    ).rejects.toEqual(new ConflictException('Resource is already favorited'));
  });

  it('removes only the current user favorite', async () => {
    const { prisma, service } = createService();

    await expect(
      service.unfavoriteResource('student-id', [RoleName.student], resource.id),
    ).resolves.toEqual({ success: true, message: 'Resource removed from favorites' });
    expect(prisma.savedResource.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'student-id', resourceId: resource.id },
    });
  });

  it('lists only favorites visible to the current user', async () => {
    const { prisma, service } = createService();

    await expect(
      service.listFavorites('student-id', [RoleName.student]),
    ).resolves.toEqual([resource]);
    expect(prisma.savedResource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'student-id' }),
    }));
  });

  it('searches public resources with filters and pagination', async () => {
    const { prisma, service } = createService();

    await expect(
      service.listResources('student-id', [RoleName.student], {
        page: 2,
        limit: 10,
        search: 'TypeScript',
        categoryId: 'category-id',
        tagId: 'tag-id',
        type: 'pdf' as never,
        visibility: CourseVisibility.public,
      }),
    ).resolves.toEqual({ items: [resource], total: 1, page: 2, limit: 10, totalPages: 1 });

    const where = prisma.libraryResource.count.mock.calls[0][0].where;
    expect(where).toEqual(expect.objectContaining({
      deletedAt: null,
      categoryId: 'category-id',
      type: 'pdf',
    }));
    expect(where.AND).toEqual(expect.arrayContaining([
      { visibility: CourseVisibility.public },
    ]));
    expect(where.tags).toEqual({ some: { tagId: 'tag-id' } });
    expect(where.AND).toEqual(expect.arrayContaining([expect.objectContaining({ OR: expect.any(Array) })]));
    expect(where.AND.find((condition: { OR?: unknown[] }) => condition.OR)?.OR).toHaveLength(6);
    expect(prisma.libraryResource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 10,
      take: 10,
    }));
  });

  it('allows instructors to see public resources and their own private resources', async () => {
    const { prisma, service } = createService();

    await service.listResources('instructor-id', [RoleName.instructor], {
      page: 1,
      limit: 20,
    });

    expect(prisma.libraryResource.count.mock.calls[0][0].where.AND).toEqual(expect.arrayContaining([{
      OR: [
        { visibility: CourseVisibility.public },
        { ownerId: 'instructor-id' },
      ],
    }]));
  });

  it('keeps private visibility filters scoped to the instructor owner', async () => {
    const { prisma, service } = createService();

    await service.listResources('instructor-id', [RoleName.instructor], {
      page: 1,
      limit: 20,
      visibility: CourseVisibility.private,
    });

    expect(prisma.libraryResource.count.mock.calls[0][0].where.AND).toEqual([
      { visibility: CourseVisibility.private },
      { OR: [{ visibility: CourseVisibility.public }, { ownerId: 'instructor-id' }] },
    ]);
  });

  it('stores the generated R2 URL and selected tag links', async () => {
    const { prisma, service, storage } = createService();

    await expect(
      service.createResource(
        'owner-id',
        {
          title: resource.title,
          categoryId: resource.categoryId,
          type: 'pdf' as never,
          tagIds: ['tag-id'],
        },
        { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', size: 3 },
      ),
    ).resolves.toEqual(resource);

    expect(storage.uploadResource).toHaveBeenCalled();
    expect(prisma.libraryResource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 'owner-id',
        categoryId: 'category-id',
        fileUrl: resource.fileUrl,
        tags: { create: [{ tag: { connect: { id: 'tag-id' } } }] },
      }),
      select: expect.any(Object),
    });
  });

  it('rejects resources with a missing category before upload', async () => {
    const { prisma, service, storage } = createService();
    prisma.libraryCategory.findUnique.mockResolvedValue(null);

    await expect(
      service.createResource('owner-id', {
        title: resource.title,
        categoryId: 'missing-category',
        type: 'pdf' as never,
      }),
    ).rejects.toEqual(new NotFoundException('Library category not found'));
    expect(storage.uploadResource).not.toHaveBeenCalled();
  });

  it('rejects unknown tags before uploading the file', async () => {
    const { prisma, service, storage } = createService();
    prisma.libraryTag.findMany.mockResolvedValue([]);

    await expect(
      service.createResource('owner-id', {
        title: resource.title,
        categoryId: resource.categoryId,
        type: 'pdf' as never,
        tagIds: ['missing-tag'],
      }),
    ).rejects.toEqual(new BadRequestException('One or more library tags are invalid'));
    expect(storage.uploadResource).not.toHaveBeenCalled();
  });
});
