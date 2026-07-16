import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiConversationService } from './ai-conversation.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { AiRetrievalService } from './ai-retrieval.service';
import { AiRateLimitService } from './ai-rate-limit.service';
import { OpenAiService } from './openai.service';

@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule],
  controllers: [AiController],
  providers: [AiConversationService, AiEmbeddingService, AiRateLimitService, AiRetrievalService, OpenAiService],
  exports: [AiConversationService, AiRetrievalService, OpenAiService],
})
export class AiModule {}
