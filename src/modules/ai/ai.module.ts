import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiConversationService } from './ai-conversation.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { AiRetrievalService } from './ai-retrieval.service';
import { AiRateLimitService } from './ai-rate-limit.service';
import { AiSummaryService } from './ai-summary.service';
import { AiGenerationService } from './ai-generation.service';
import { AiSourcesService } from './ai-sources.service';
import { OpenAiService } from './openai.service';
import { GeminiService } from './gemini.service';
import { AI_PROVIDER, AiProvider } from './ai-provider';
import { MockAiProviderService } from './mock-ai-provider.service';
import { AiLearningPathService } from './ai-learning-path.service';

const aiProvider = {
  provide: AI_PROVIDER,
  inject: [AppConfigService, GeminiService, OpenAiService, MockAiProviderService],
  useFactory: (
    config: AppConfigService,
    gemini: GeminiService,
    openai: OpenAiService,
    mock: MockAiProviderService,
  ): AiProvider => {
    if (config.ai.provider === 'mock') return mock;
    if (config.ai.provider === 'openai') return openai;
    return gemini;
  },
};

@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule],
  controllers: [AiController],
  providers: [
    AiConversationService,
    AiEmbeddingService,
    AiRateLimitService,
    AiRetrievalService,
    AiSummaryService,
    AiGenerationService,
    AiSourcesService,
    AiLearningPathService,
    OpenAiService,
    GeminiService,
    MockAiProviderService,
    aiProvider,
  ],
  exports: [AiConversationService, AiRetrievalService, AI_PROVIDER],
})
export class AiModule {}
