import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AiRetrievalService } from './ai-retrieval.service';

const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };

describe('AiRetrievalService', () => {
  it('embeds the query, applies top-k, and formats permitted sources', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        embedding_id: 'embedding-id',
        source_type: 'lesson',
        source_id: 'lesson-id',
        title: 'Gradient descent',
        chunk_text: 'Gradient descent updates weights.',
        distance: 0.2,
        metadata_json: { courseId: 'course-id' },
        course_id: 'course-id',
        citation_path: '/courses/course-id',
      },
    ]);
    const embed = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const service = new AiRetrievalService(
      { $queryRaw: queryRaw } as never,
      {
        embed,
      } as never,
    );

    await expect(service.retrieve(student, '  explain gradient descent  ', { topK: 3 })).resolves.toEqual([
      {
        embeddingId: 'embedding-id',
        sourceType: 'lesson',
        sourceId: 'lesson-id',
        title: 'Gradient descent',
        chunkText: 'Gradient descent updates weights.',
        similarity: 0.8,
        courseId: 'course-id',
        citationPath: '/courses/course-id',
        metadata: { courseId: 'course-id' },
      },
    ]);
    expect(embed).toHaveBeenCalledWith('explain gradient descent');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const sql = query.strings.join(' ');
    expect(sql).toContain('l.is_preview = TRUE');
    expect(sql).toContain("'/learning/' || c.id::text");
    expect(sql).toContain("'/courses/' || c.id::text");
    expect(sql).toContain("en.status IN ('active', 'completed')");
    expect(sql).toContain("c.moderation_status = 'clear'");
    expect(sql).toContain("r.moderation_status = 'clear'");
    expect(sql).toContain('c.id =  ::uuid');
    expect(sql).toContain('AND  ::uuid IS NULL');
    expect(sql).toContain('::uuid IS NULL');
    expect(query.values).toContain(null);
  });

  it('returns no sources for blank queries without calling providers', async () => {
    const service = new AiRetrievalService(
      { $queryRaw: jest.fn() } as never,
      { embed: jest.fn() } as never,
    );

    await expect(service.retrieve(student, '   ')).resolves.toEqual([]);
  });

  it('binds a course context when one is selected', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const service = new AiRetrievalService(
      { $queryRaw: queryRaw } as never,
      { embed: jest.fn().mockResolvedValue([[0.1]]) } as never,
    );

    await service.retrieve(student, 'course question', { courseId: 'course-id' });

    const query = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(query.values).toContain('course-id');
  });

  it('rejects unsafe top-k values', async () => {
    const service = new AiRetrievalService({ $queryRaw: jest.fn() } as never, {} as never);

    await expect(service.retrieve(student, 'query', { topK: 21 })).rejects.toThrow(
      'topK must be an integer between 1 and 20',
    );
  });
});
