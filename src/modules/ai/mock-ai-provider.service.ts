import { Injectable } from '@nestjs/common';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from './ai-provider';

const EMBEDDING_DIMENSIONS = 1536;

@Injectable()
export class MockAiProviderService implements AiProvider {
  getModel(): string {
    return 'mock';
  }

  getEmbeddingModel(): string {
    return 'mock';
  }

  async complete(
    request: AiCompletionRequest,
  ): Promise<AiCompletionResult> {
    const prompt =
      request.messages[request.messages.length - 1]?.content ?? '';
    const systemPrompt =
      request.messages.find((message) => message.role === 'system')?.content ??
      '';
    const content = request.json
      ? this.generateStructuredContent(prompt)
      : this.generateTextContent(systemPrompt, prompt);

    return {
      content,
      totalTokens: Math.max(1, Math.ceil(content.length / 4)),
    };
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const values = Array.isArray(input) ? input : [input];
    return values.map((value) => this.createEmbedding(value));
  }

  private generateStructuredContent(prompt: string): string {
    const count = this.extractCount(prompt);

    if (/multiple-choice|question/i.test(prompt)) {
      return JSON.stringify({
        items: Array.from({ length: count }, (_, index) => {
          const correctAnswer = `Đáp án ${index + 1}A`;
          return {
            question: `Câu hỏi demo ${index + 1} dựa trên nội dung đã chọn?`,
            options: [
              correctAnswer,
              `Đáp án ${index + 1}B`,
              `Đáp án ${index + 1}C`,
              `Đáp án ${index + 1}D`,
            ],
            correctAnswer,
            explanation:
              'Đây là kết quả xác định từ AI_PROVIDER=mock để kiểm thử giao diện.',
          };
        }),
      });
    }

    return JSON.stringify({
      items: Array.from({ length: count }, (_, index) => ({
        front: `Thẻ ghi nhớ demo ${index + 1}`,
        back: `Nội dung ôn tập xác định ${index + 1}.`,
      })),
    });
  }

  private generateTextContent(systemPrompt: string, prompt: string): string {
    if (/summary|summarize/i.test(systemPrompt)) {
      const title = prompt.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? 'bài học';
      return `Tóm tắt demo cho ${title}: các ý chính đã được cô đọng từ nguồn học liệu đã chọn.`;
    }

    const question = prompt
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    return `Trợ giảng EduAI (mock): ${question || 'Hãy chọn một nguồn học liệu để bắt đầu.'}`;
  }

  private extractCount(prompt: string): number {
    const parsed = Number(prompt.match(/exactly\s+(\d+)\s+items/i)?.[1] ?? 5);
    return Number.isInteger(parsed) ? Math.min(20, Math.max(1, parsed)) : 5;
  }

  private createEmbedding(value: string): number[] {
    let state = 2166136261;
    for (const character of value) {
      state ^= character.codePointAt(0) ?? 0;
      state = Math.imul(state, 16777619);
    }

    return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
      state ^= index + 1;
      state = Math.imul(state, 16777619);
      return Number((((state >>> 0) / 0xffffffff) * 2 - 1).toFixed(8));
    });
  }
}
