import { buildAiTutorPrompt } from './ai-prompt-builder';

describe('buildAiTutorPrompt', () => {
  it('formats numbered source citations into the prompt', () => {
    expect(buildAiTutorPrompt('What is recursion?', [{
      embeddingId: 'embedding-id', sourceType: 'lesson', sourceId: 'lesson-id',
      title: 'Recursion', chunkText: 'A function calls itself.', similarity: 0.9, metadata: {},
    }])).toContain('[Source 1] Recursion (lesson:lesson-id)');
  });
});
