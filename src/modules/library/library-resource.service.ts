import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

export interface LibraryFavoriteActionResponse {
  success: true;
  message: string;
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

  async listFavorites(userId: string, roles: RoleName[]): Promise<LibraryResourceResponse[]> {
    const visibleResources = this.buildResourceWhere(userId, roles, {
      page: 1,
      limit: 100,
    });
    const favorites = await this.prisma.savedResource.findMany({
      where: {
        userId,
        resource: visibleResources,
      },
      orderBy: { createdAt: 'desc' },
      select: { resource: { select: resourceSelect } },
    });

    return favorites.map(({ resource }) => resource);
  }

  async favoriteResource(
    userId: string,
    roles: RoleName[],
    resourceId: string,
  ): Promise<LibraryFavoriteActionResponse> {
    await this.ensureVisibleResource(userId, roles, resourceId);

    try {
      await this.prisma.savedResource.create({
        data: { userId, resourceId },
      });
    } catch (error) {
      if (this.isFavoriteConflict(error)) {
        throw new ConflictException('Resource is already favorited');
      }
      throw error;
    }

    return { success: true, message: 'Resource added to favorites' };
  }

  async unfavoriteResource(
    userId: string,
    roles: RoleName[],
    resourceId: string,
  ): Promise<LibraryFavoriteActionResponse> {
    await this.ensureVisibleResource(userId, roles, resourceId);
    await this.prisma.savedResource.deleteMany({
      where: { userId, resourceId },
    });

    return { success: true, message: 'Resource removed from favorites' };
  }

  private async ensureVisibleResource(
    userId: string,
    roles: RoleName[],
    resourceId: string,
  ): Promise<void> {
    const resource = await this.prisma.libraryResource.findFirst({
      where: {
        id: resourceId,
        ...this.buildResourceWhere(userId, roles, { page: 1, limit: 100 }),
      },
      select: { id: true },
    });
    if (!resource) throw new NotFoundException('Library resource not found');
  }

  private isFavoriteConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('user_id') &&
      error.meta.target.includes('resource_id')
    );
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
