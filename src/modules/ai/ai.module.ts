import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiConversationService } from './ai-conversation.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { AiRetrievalService } from './ai-retrieval.service';
import { AiRateLimitService } from './ai-rate-limit.service';
import { AiSummaryService } from './ai-summary.service';
import { AiGenerationService } from './ai-generation.service';
import { OpenAiService } from './openai.service';

@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule],
  controllers: [AiController],
  providers: [AiConversationService, AiEmbeddingService, AiRateLimitService, AiRetrievalService, AiSummaryService, AiGenerationService, OpenAiService],
  exports: [AiConversationService, AiRetrievalService, OpenAiService],
})
export class AiModule {}
