import { BadGatewayException, Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { OpenAiService } from './openai.service';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

export type RetrievalSourceType = 'lesson' | 'library_resource';

export interface AiRetrievalOptions {
  topK?: number;
}

export interface AiRetrievalSource {
  embeddingId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  title: string;
  chunkText: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

interface RetrievalRow {
  embedding_id: string;
  source_type: RetrievalSourceType;
  source_id: string;
  title: string;
  chunk_text: string;
  distance: number;
  metadata_json: unknown;
}

@Injectable()
export class AiRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
  ) {}

  async retrieve(
    user: AuthenticatedUser,
    query: string,
    options: AiRetrievalOptions = {},
  ): Promise<AiRetrievalSource[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const topK = this.normalizeTopK(options.topK);
    const response = await this.openai.getClient().embeddings.create({
      model: this.openai.getEmbeddingModel(),
      input: normalizedQuery,
    });
    const embedding = response.data[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.some((value) => !Number.isFinite(value))) {
      throw new BadGatewayException('Embedding provider returned invalid data');
    }

    const vector = JSON.stringify(embedding);
    const isAdmin = user.roles.includes(RoleName.platform_admin);
    const rows = await this.prisma.$queryRaw<RetrievalRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT
          e.id AS embedding_id,
          e.source_type,
          e.source_id,
          l.title,
          e.chunk_text,
          e.embedding <=> ${vector}::vector AS distance,
          e.metadata_json
        FROM "ai_embeddings" e
        INNER JOIN "lessons" l ON l.id = e.source_id
        INNER JOIN "courses" c ON c.id = l.course_id
        WHERE e.source_type = 'lesson'
          AND e.embedding IS NOT NULL
          AND l.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND (
            ${isAdmin}
            OR (c.status = 'published' AND c.visibility = 'public')
            OR c.instructor_id = ${user.id}::uuid
            OR EXISTS (
              SELECT 1 FROM "enrollments" en
              WHERE en.course_id = c.id AND en.user_id = ${user.id}::uuid AND en.status = 'active'
            )
          )
        UNION ALL
        SELECT
          e.id AS embedding_id,
          e.source_type,
          e.source_id,
          r.title,
          e.chunk_text,
          e.embedding <=> ${vector}::vector AS distance,
          e.metadata_json
        FROM "ai_embeddings" e
        INNER JOIN "library_resources" r ON r.id = e.source_id
        WHERE e.source_type = 'library_resource'
          AND e.embedding IS NOT NULL
          AND r.deleted_at IS NULL
          AND (${isAdmin} OR r.visibility = 'public' OR r.owner_id = ${user.id}::uuid)
      ) AS permitted_sources
      ORDER BY distance ASC
      LIMIT ${topK}
    `);

    return rows.map((row) => ({
      embeddingId: row.embedding_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      chunkText: row.chunk_text,
      similarity: 1 - Number(row.distance),
      metadata: this.toMetadata(row.metadata_json),
    }));
  }

  private normalizeTopK(topK?: number): number {
    if (topK === undefined) return DEFAULT_TOP_K;
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      throw new RangeError(`topK must be an integer between 1 and ${MAX_TOP_K}`);
    }
    return topK;
  }

  private toMetadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
