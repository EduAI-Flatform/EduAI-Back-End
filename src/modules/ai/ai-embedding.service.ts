import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AI_PROVIDER, AiProvider } from './ai-provider';
import { chunkText, TextChunk } from './text-chunker';

type EmbeddingSourceType = 'lesson' | 'library_resource';

export interface EmbeddingJobResult {
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkCount: number;
}

export interface EmbeddingRebuildResult {
  lessons: number;
  libraryResources: number;
  chunkCount: number;
}

interface EmbeddingMetadata {
  sourceType: EmbeddingSourceType;
  sourceId: string;
  [key: string]: string;
}

@Injectable()
export class AiEmbeddingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AiProvider,
  ) {}

  async embedLesson(
    user: AuthenticatedUser,
    lessonId: string,
  ): Promise<EmbeddingJobResult> {
    if (!this.canManageContent(user)) {
      throw new NotFoundException('Lesson not found');
    }

    const lesson = await this.prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
        course: {
          deletedAt: null,
          ...(this.isAdmin(user) ? {} : { instructorId: user.id }),
        },
      },
      select: {
        id: true,
        title: true,
        content: true,
        course: { select: { id: true } },
      },
    });

    if (!lesson) throw new NotFoundException('Lesson not found');

    return this.embedSource(
      'lesson',
      lesson.id,
      `${lesson.title} ${lesson.content ?? ''}`,
      { courseId: lesson.course.id },
    );
  }

  async embedLibraryResource(
    user: AuthenticatedUser,
    resourceId: string,
  ): Promise<EmbeddingJobResult> {
    if (!this.canManageContent(user)) {
      throw new NotFoundException('Library resource not found');
    }

    const resource = await this.prisma.libraryResource.findFirst({
      where: {
        id: resourceId,
        deletedAt: null,
        ...(this.isAdmin(user) ? {} : { ownerId: user.id }),
      },
      select: {
        id: true,
        title: true,
        description: true,
      },
    });

    if (!resource) throw new NotFoundException('Library resource not found');

    return this.embedSource(
      'library_resource',
      resource.id,
      `${resource.title} ${resource.description ?? ''}`,
      {},
    );
  }

  async rebuildAll(user: AuthenticatedUser): Promise<EmbeddingRebuildResult> {
    if (!this.isAdmin(user)) {
      throw new ForbiddenException('Platform administrator role required');
    }

    const [lessons, resources] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { deletedAt: null, course: { deletedAt: null } },
        select: {
          id: true,
          title: true,
          content: true,
          course: { select: { id: true } },
        },
      }),
      this.prisma.libraryResource.findMany({
        where: { deletedAt: null },
        select: { id: true, title: true, description: true },
      }),
    ]);

    let chunkCount = 0;
    for (const lesson of lessons) {
      chunkCount += await this.replaceSource(
        'lesson',
        lesson.id,
        `${lesson.title} ${lesson.content ?? ''}`,
        { courseId: lesson.course.id },
      );
    }
    for (const resource of resources) {
      chunkCount += await this.replaceSource(
        'library_resource',
        resource.id,
        `${resource.title} ${resource.description ?? ''}`,
        {},
      );
    }

    return { lessons: lessons.length, libraryResources: resources.length, chunkCount };
  }

  private async embedSource(
    sourceType: EmbeddingSourceType,
    sourceId: string,
    sourceText: string,
    metadata: Omit<EmbeddingMetadata, 'sourceType' | 'sourceId'>,
  ): Promise<EmbeddingJobResult> {
    const chunks = chunkText(sourceText);
    if (chunks.length === 0) {
      throw new NotFoundException('No indexable text found');
    }

    const embeddings = await this.aiProvider.embed(
      chunks.map(({ text }) => text),
    );

    if (
      embeddings.length !== chunks.length ||
      embeddings.some(
        (embedding) =>
          !Array.isArray(embedding) ||
          embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new BadGatewayException('Embedding provider returned invalid data');
    }

    for (const [index, chunk] of chunks.entries()) {
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "ai_embeddings"
            ("source_type", "source_id", "chunk_text", "embedding", "metadata_json")
          VALUES
            (${sourceType}, ${sourceId}::uuid, ${chunk.text}, ${JSON.stringify(embeddings[index])}::vector, ${JSON.stringify({ sourceType, sourceId, chunkIndex: String(chunk.index), ...metadata })}::jsonb)
        `,
      );
    }

    return { sourceType, sourceId, chunkCount: chunks.length };
  }

  private async replaceSource(
    sourceType: EmbeddingSourceType,
    sourceId: string,
    sourceText: string,
    metadata: Omit<EmbeddingMetadata, 'sourceType' | 'sourceId'>,
  ): Promise<number> {
    const chunks = chunkText(sourceText);
    if (chunks.length === 0) return 0;

    const embeddings = await this.aiProvider.embed(chunks.map(({ text }) => text));
    if (
      embeddings.length !== chunks.length ||
      embeddings.some(
        (embedding) =>
          !Array.isArray(embedding) || embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new BadGatewayException('Embedding provider returned invalid data');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM "ai_embeddings" WHERE "source_type" = ${sourceType} AND "source_id" = ${sourceId}::uuid`,
      );
      for (const [index, chunk] of chunks.entries()) {
        await tx.$executeRaw(
          Prisma.sql`
            INSERT INTO "ai_embeddings"
              ("source_type", "source_id", "chunk_text", "embedding", "metadata_json")
            VALUES
              (${sourceType}, ${sourceId}::uuid, ${chunk.text}, ${JSON.stringify(embeddings[index])}::vector, ${JSON.stringify({ sourceType, sourceId, chunkIndex: String(chunk.index), ...metadata })}::jsonb)
          `,
        );
      }
    });
    return chunks.length;
  }

  private canManageContent(user: AuthenticatedUser): boolean {
    return this.isAdmin(user) || user.roles.includes(RoleName.instructor);
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes(RoleName.platform_admin);
  }
}
