import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, CourseVisibility } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLibraryResourceDto } from './dto/create-library-resource.dto';
import { LibraryR2StorageService } from './library-r2-storage.service';
import { UploadedLibraryFile } from './types/library-upload.types';

const resourceSelect = {
  id: true,
  ownerId: true,
  categoryId: true,
  title: true,
  description: true,
  type: true,
  fileUrl: true,
  externalUrl: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, slug: true } },
  tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.LibraryResourceSelect;

export type LibraryResourceResponse = Prisma.LibraryResourceGetPayload<{
  select: typeof resourceSelect;
}>;

@Injectable()
export class LibraryResourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LibraryR2StorageService,
  ) {}

  async createResource(
    ownerId: string,
    input: CreateLibraryResourceDto,
    file?: UploadedLibraryFile,
  ): Promise<LibraryResourceResponse> {
    const category = await this.prisma.libraryCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Library category not found');

    const tagIds = input.tagIds ?? [];
    if (tagIds.length > 0) {
      const tags = await this.prisma.libraryTag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true },
      });
      if (tags.length !== new Set(tagIds).size) {
        throw new BadRequestException('One or more library tags are invalid');
      }
    }

    const storedFile = await this.storage.uploadResource(file, input.type);
    return this.prisma.libraryResource.create({
      data: {
        ownerId,
        categoryId: input.categoryId,
        title: input.title,
        description: input.description,
        type: input.type,
        fileUrl: storedFile.url,
        visibility: input.visibility ?? CourseVisibility.public,
        tags: tagIds.length
          ? { create: tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })) }
          : undefined,
      },
      select: resourceSelect,
    });
  }
}
