import { chunkText } from './text-chunker';

describe('chunkText', () => {
  it('normalizes whitespace and returns one chunk for short text', () => {
    expect(chunkText('  Learn   AI\n\nwith examples.  ')).toEqual([
      { index: 0, text: 'Learn AI with examples.' },
    ]);
  });

  it('splits long text into bounded overlapping chunks', () => {
    const chunks = chunkText('one two three four five six seven eight nine ten', 24, 8);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 24)).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks[0].text.split(' ').slice(-1)[0]).toBe(
      chunks[1].text.split(' ')[0],
    );
  });

  it('rejects invalid chunk options', () => {
    expect(() => chunkText('text', 0)).toThrow('maxChars');
    expect(() => chunkText('text', 10, 10)).toThrow('overlapChars');
  });
});
