import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { AiRateLimitService } from './ai-rate-limit.service';

const aiMessageResponseSelect = {
  id: true,
  role: true,
  content: true,
  tokenCount: true,
  model: true,
  createdAt: true,
} satisfies Prisma.AiMessageSelect;

type AiMessageResponse = Prisma.AiMessageGetPayload<{
  select: typeof aiMessageResponseSelect;
}>;

export interface AiChatResponse {
  conversationId: string;
  message: AiMessageResponse;
}

@Injectable()
export class AiConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AiRateLimitService,
  ) {}

  async createChat(
    user: AuthenticatedUser,
    input: CreateAiChatDto,
  ): Promise<AiChatResponse> {
    await this.rateLimit.assertChatAllowed(user.id);

    return this.prisma.$transaction(async (tx) => {
      const conversationId = input.conversationId
        ? await this.assertConversationOwnership(tx, input.conversationId, user.id)
        : await this.createConversation(tx, user.id, input);

      const message = await tx.aiMessage.create({
        data: {
          conversationId,
          role: 'user',
          content: input.message,
        },
        select: aiMessageResponseSelect,
      });

      return { conversationId, message };
    });
  }

  private async assertConversationOwnership(
    tx: Prisma.TransactionClient,
    conversationId: string,
    userId: string,
  ): Promise<string> {
    const conversation = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundException('AI conversation not found');
    }

    return conversation.id;
  }

  private async createConversation(
    tx: Prisma.TransactionClient,
    userId: string,
    input: CreateAiChatDto,
  ): Promise<string> {
    const conversation = await tx.aiConversation.create({
      data: {
        userId,
        title: input.title ?? 'AI conversation',
        ...(input.contextType ? { contextType: input.contextType } : {}),
        ...(input.contextId ? { contextId: input.contextId } : {}),
      },
      select: { id: true },
    });

    return conversation.id;
  }
}
