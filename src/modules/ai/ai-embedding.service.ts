import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { OpenAiService } from './openai.service';
import { chunkText, TextChunk } from './text-chunker';

type EmbeddingSourceType = 'lesson' | 'library_resource';

export interface EmbeddingJobResult {
  sourceType: EmbeddingSourceType;
  sourceId: string;
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
    private readonly openai: OpenAiService,
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

    const response = await this.openai.getClient().embeddings.create({
      model: this.openai.getEmbeddingModel(),
      input: chunks.map(({ text }) => text),
    });
    const embeddings = [...response.data].sort((left, right) => left.index - right.index);

    if (
      embeddings.length !== chunks.length ||
      embeddings.some((item) => !Array.isArray(item.embedding) || item.embedding.some((value) => !Number.isFinite(value)))
    ) {
      throw new BadGatewayException('Embedding provider returned invalid data');
    }

    for (const [index, chunk] of chunks.entries()) {
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "ai_embeddings"
            ("source_type", "source_id", "chunk_text", "embedding", "metadata_json")
          VALUES
            (${sourceType}, ${sourceId}::uuid, ${chunk.text}, ${JSON.stringify(embeddings[index].embedding)}::vector, ${JSON.stringify({ sourceType, sourceId, chunkIndex: String(chunk.index), ...metadata })}::jsonb)
        `,
      );
    }

    return { sourceType, sourceId, chunkCount: chunks.length };
  }

  private canManageContent(user: AuthenticatedUser): boolean {
    return this.isAdmin(user) || user.roles.includes(RoleName.instructor);
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes(RoleName.platform_admin);
  }
}
