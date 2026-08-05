import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../../config/app-config.service';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from './ai-provider';

@Injectable()
export class OpenAiService implements AiProvider {
  private client?: OpenAI;

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.openai.apiKey);
  }

  getModel(): string {
    const model = this.appConfig.openai.model;
    if (!model) {
      throw new ServiceUnavailableException('OpenAI service is not configured');
    }

    return model;
  }

  getEmbeddingModel(): string {
    const model = this.appConfig.openai.embeddingModel;
    if (!model) {
      throw new ServiceUnavailableException('OpenAI embedding service is not configured');
    }

    return model;
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
