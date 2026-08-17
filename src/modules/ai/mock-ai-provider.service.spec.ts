import { MockAiProviderService } from './mock-ai-provider.service';

describe('MockAiProviderService', () => {
  const provider = new MockAiProviderService();

  it('returns deterministic chat and summary content', async () => {
    const request = {
      messages: [
        {
          role: 'system' as const,
          content: 'You are EduAI Summary. Summarize learning content.',
        },
        {
          role: 'user' as const,
          content: 'Title: Machine Learning\n\nContent:\nGradient descent basics.',
        },
      ],
    };

    await expect(provider.complete(request)).resolves.toEqual(
      await provider.complete(request),
    );
    await expect(provider.complete(request)).resolves.toEqual(
      expect.objectContaining({
        content: expect.stringContaining('Machine Learning'),
      }),
    );
  });

  it('returns valid deterministic quiz and flashcard JSON', async () => {
    const quiz = await provider.complete({
      json: true,
      messages: [
        {
          role: 'user',
          content:
            'Generate multiple-choice questions. Generate exactly 3 items.',
        },
      ],
    });
    const flashcards = await provider.complete({
      json: true,
      messages: [
        {
          role: 'user',
          content: 'Generate study flashcards. Generate exactly 2 items.',
        },
      ],
    });

    expect(JSON.parse(quiz.content ?? '{}').items).toHaveLength(3);
    expect(JSON.parse(flashcards.content ?? '{}').items).toHaveLength(2);
  });

  it('returns a schema-valid learning path limited to supplied course IDs', async () => {
    const response = await provider.complete({
      json: true,
      messages: [
        {
          role: 'user',
          content:
            'Create a short learner path from this safe JSON:\n{"courses":[{"id":"course-a"},{"id":"course-b"}]}',
        },
      ],
    });

    expect(JSON.parse(response.content ?? '{}')).toEqual({
      schemaVersion: 'v1',
      milestones: [
        { courseId: 'course-a', priority: 1, reason: expect.any(String) },
        { courseId: 'course-b', priority: 2, reason: expect.any(String) },
      ],
    });
  });

  it('returns stable 1536-dimensional embeddings', async () => {
    const first = await provider.embed(['EduAI', 'PostgreSQL']);
    const second = await provider.embed(['EduAI', 'PostgreSQL']);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toHaveLength(1536);
    expect(first.flat().every(Number.isFinite)).toBe(true);
  });
});
