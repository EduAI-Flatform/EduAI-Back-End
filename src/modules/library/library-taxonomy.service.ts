import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateLibraryCategoryDto,
  CreateLibraryTagDto,
  UpdateLibraryCategoryDto,
  UpdateLibraryTagDto,
} from './dto/create-library-taxonomy.dto';

const categorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LibraryCategorySelect;

const tagSelect = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
} satisfies Prisma.LibraryTagSelect;

export type LibraryCategoryResponse = Prisma.LibraryCategoryGetPayload<{
  select: typeof categorySelect;
}>;

export type LibraryTagResponse = Prisma.LibraryTagGetPayload<{
  select: typeof tagSelect;
}>;

@Injectable()
export class LibraryTaxonomyService {
  constructor(private readonly prisma: PrismaService) {}

  listCategories(): Promise<LibraryCategoryResponse[]> {
    return this.prisma.libraryCategory.findMany({
      orderBy: { name: 'asc' },
      select: categorySelect,
    });
  }

  async createCategory(input: CreateLibraryCategoryDto): Promise<LibraryCategoryResponse> {
    try {
      return await this.prisma.libraryCategory.create({
        data: input,
        select: categorySelect,
      });
    } catch (error) {
      this.throwSlugConflict(error, 'Category slug is already in use');
      throw error;
    }
  }

  async updateCategory(
    id: string,
    input: UpdateLibraryCategoryDto,
  ): Promise<LibraryCategoryResponse> {
    await this.ensureCategory(id);
    try {
      return await this.prisma.libraryCategory.update({
        where: { id },
        data: input,
        select: categorySelect,
      });
    } catch (error) {
      this.throwSlugConflict(error, 'Category slug is already in use');
      throw error;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    await this.ensureCategory(id);
    try {
      await this.prisma.libraryCategory.delete({ where: { id } });
    } catch (error) {
      if (this.isForeignKeyConflict(error)) {
        throw new ConflictException('Category cannot be deleted while resources use it');
      }
      throw error;
    }
  }

  listTags(): Promise<LibraryTagResponse[]> {
    return this.prisma.libraryTag.findMany({
      orderBy: { name: 'asc' },
      select: tagSelect,
    });
  }

  async createTag(input: CreateLibraryTagDto): Promise<LibraryTagResponse> {
    try {
      return await this.prisma.libraryTag.create({ data: input, select: tagSelect });
    } catch (error) {
      this.throwSlugConflict(error, 'Tag slug is already in use');
      throw error;
    }
  }

  async updateTag(id: string, input: UpdateLibraryTagDto): Promise<LibraryTagResponse> {
    await this.ensureTag(id);
    try {
      return await this.prisma.libraryTag.update({
        where: { id },
        data: input,
        select: tagSelect,
      });
    } catch (error) {
      this.throwSlugConflict(error, 'Tag slug is already in use');
      throw error;
    }
  }

  async deleteTag(id: string): Promise<void> {
    await this.ensureTag(id);
    await this.prisma.libraryTag.delete({ where: { id } });
  }

  private async ensureCategory(id: string): Promise<void> {
    if (!(await this.prisma.libraryCategory.findUnique({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Library category not found');
    }
  }

  private async ensureTag(id: string): Promise<void> {
    if (!(await this.prisma.libraryTag.findUnique({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Library tag not found');
    }
  }

  private throwSlugConflict(error: unknown, message: string): void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('slug')
    ) {
      throw new ConflictException(message);
    }
  }

  private isForeignKeyConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
  }
}
