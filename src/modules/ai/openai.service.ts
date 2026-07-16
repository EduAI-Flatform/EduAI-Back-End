import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../../config/app-config.service';

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

@Injectable()
export class OpenAiService {
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
}
