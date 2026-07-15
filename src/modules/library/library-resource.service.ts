import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CourseVisibility, Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLibraryResourceDto } from './dto/create-library-resource.dto';
import { ListLibraryResourcesQueryDto } from './dto/list-library-resources-query.dto';
import { LibraryR2StorageService } from './library-r2-storage.service';
import { UploadedLibraryFile } from './types/library-upload.types';

const resourceSelect = {
  id: true,
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

export interface PaginatedLibraryResourceResponse {
  items: LibraryResourceResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class LibraryResourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LibraryR2StorageService,
  ) {}

  async listResources(
    userId: string,
    roles: RoleName[],
    query: ListLibraryResourcesQueryDto,
  ): Promise<PaginatedLibraryResourceResponse> {
    const page = query.page;
    const limit = query.limit;
    const where = this.buildResourceWhere(userId, roles, query);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.libraryResource.count({ where }),
      this.prisma.libraryResource.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: resourceSelect,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

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

  private buildResourceWhere(
    userId: string,
    roles: RoleName[],
    query: ListLibraryResourcesQueryDto,
  ): Prisma.LibraryResourceWhereInput {
    const isAdmin = roles.includes(RoleName.platform_admin);
    const isInstructor = roles.includes(RoleName.instructor);
    const allowedVisibility = isAdmin
      ? null
      : isInstructor
        ? { OR: [{ visibility: CourseVisibility.public }, { ownerId: userId }] }
        : { visibility: CourseVisibility.public };
    const search = query.search?.trim();
    const conditions: Prisma.LibraryResourceWhereInput[] = [];

    if (query.visibility) conditions.push({ visibility: query.visibility });
    if (allowedVisibility) conditions.push(allowedVisibility);

    if (search) {
      conditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { category: { name: { contains: search, mode: 'insensitive' } } },
          { category: { slug: { contains: search, mode: 'insensitive' } } },
          { tags: { some: { tag: { name: { contains: search, mode: 'insensitive' } } } } },
          { tags: { some: { tag: { slug: { contains: search, mode: 'insensitive' } } } } },
        ],
      });
    }

    return {
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(conditions.length ? { AND: conditions } : {}),
    };
  }
}
