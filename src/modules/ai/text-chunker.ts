export interface TextChunk {
  index: number;
  text: string;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 200;

export function chunkText(
  value: string,
  maxChars = DEFAULT_MAX_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
): TextChunk[] {
  if (maxChars <= 0) throw new Error('maxChars must be greater than zero');
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error('overlapChars must be less than maxChars');
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const words = normalized.split(' ');
  const chunks: TextChunk[] = [];
  let current: string[] = [];

  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length > 0 && candidate.length > maxChars) {
      chunks.push({ index: chunks.length, text: current.join(' ') });
      current = takeOverlap(current, overlapChars);
    }
    current.push(word);
  }

  if (current.length > 0) {
    chunks.push({ index: chunks.length, text: current.join(' ') });
  }

  return chunks;
}

function takeOverlap(words: string[], maxChars: number): string[] {
  const overlap: string[] = [];

  for (let index = words.length - 1; index >= 0; index -= 1) {
    const candidate = [words[index], ...overlap].join(' ');
    if (candidate.length > maxChars) break;
    overlap.unshift(words[index]);
  }

  return overlap;
}
