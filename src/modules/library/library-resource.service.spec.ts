import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LibraryResourceService } from './library-resource.service';

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
    libraryCategory: {
      findUnique: jest.fn().mockResolvedValue({ id: 'category-id' }),
    },
    libraryTag: {
      findMany: jest.fn().mockResolvedValue([{ id: 'tag-id' }]),
    },
    libraryResource: {
      create: jest.fn().mockResolvedValue(resource),
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
