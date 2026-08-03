import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../../config/app-config.service';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from './ai-provider';

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

@Injectable()
export class OpenAiService implements AiProvider {
  private client?: OpenAI;

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.openai.apiKey);
  }

  getModel(): string {
    return this.appConfig.openai.model ?? DEFAULT_OPENAI_MODEL;
  }

  getEmbeddingModel(): string {
    return this.appConfig.openai.embeddingModel ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  }

  getClient(): OpenAI {
    const apiKey = this.appConfig.openai.apiKey;

    if (!apiKey) {
      throw new ServiceUnavailableException('OpenAI service is not configured');
    }

    this.client ??= new OpenAI({ apiKey });
    return this.client;
  }

  async complete(
    request: AiCompletionRequest,
  ): Promise<AiCompletionResult> {
    const completion = await this.getClient().chat.completions.create({
      model: this.getModel(),
      ...(request.json
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      messages: request.messages,
    });

    return {
      content: completion.choices[0]?.message?.content ?? null,
      totalTokens: completion.usage?.total_tokens,
    };
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const response = await this.getClient().embeddings.create({
      model: this.getEmbeddingModel(),
      input,
    });

    return [...response.data]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }
}
