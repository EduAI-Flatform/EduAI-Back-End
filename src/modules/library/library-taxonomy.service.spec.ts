import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { LibraryTaxonomyService } from './library-taxonomy.service';

const category = {
  id: 'category-id',
  name: 'Lập trình',
  slug: 'lap-trinh',
  description: null,
  createdAt: new Date('2026-07-15T00:00:00.000Z'),
  updatedAt: new Date('2026-07-15T00:00:00.000Z'),
};

const tag = {
  id: 'tag-id',
  name: 'TypeScript',
  slug: 'typescript',
  createdAt: new Date('2026-07-15T00:00:00.000Z'),
};

function createService() {
  const prisma = {
    libraryCategory: {
      findMany: jest.fn().mockResolvedValue([category]),
      findUnique: jest.fn().mockResolvedValue(category),
      create: jest.fn().mockResolvedValue(category),
      update: jest.fn().mockResolvedValue(category),
      delete: jest.fn().mockResolvedValue(category),
    },
    libraryTag: {
      findMany: jest.fn().mockResolvedValue([tag]),
      findUnique: jest.fn().mockResolvedValue(tag),
      create: jest.fn().mockResolvedValue(tag),
      update: jest.fn().mockResolvedValue(tag),
      delete: jest.fn().mockResolvedValue(tag),
    },
  };

  return { prisma, service: new LibraryTaxonomyService(prisma as never) };
}

describe('LibraryTaxonomyService', () => {
  it('lists categories with an explicit lean projection', async () => {
    const { prisma, service } = createService();

    await expect(service.listCategories()).resolves.toEqual([category]);
    expect(prisma.libraryCategory.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('maps duplicate category slugs to a conflict', async () => {
    const { prisma, service } = createService();
    prisma.libraryCategory.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
        meta: { target: ['slug'] },
      }),
    );

    await expect(
      service.createCategory({ name: category.name, slug: category.slug }),
    ).rejects.toEqual(new ConflictException('Category slug is already in use'));
  });

  it('rejects updates for missing tags', async () => {
    const { prisma, service } = createService();
    prisma.libraryTag.findUnique.mockResolvedValue(null);

    await expect(
      service.updateTag('missing-tag', { name: 'Updated' }),
    ).rejects.toEqual(new NotFoundException('Library tag not found'));
    expect(prisma.libraryTag.update).not.toHaveBeenCalled();
  });

  it('creates tags with the explicit tag projection', async () => {
    const { prisma, service } = createService();

    await service.createTag({ name: tag.name, slug: tag.slug });

    expect(prisma.libraryTag.create).toHaveBeenCalledWith({
      data: { name: tag.name, slug: tag.slug },
      select: { id: true, name: true, slug: true, createdAt: true },
    });
  });
});
