import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { AiRateLimitService } from './ai-rate-limit.service';
import { AiRetrievalService, AiRetrievalSource } from './ai-retrieval.service';
import { AI_TUTOR_SYSTEM_PROMPT, buildAiTutorPrompt } from './ai-prompt-builder';
import { OpenAiService } from './openai.service';

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
  sources: AiRetrievalSource[];
}

@Injectable()
export class AiConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AiRateLimitService,
    private readonly retrieval: AiRetrievalService,
    private readonly openai: OpenAiService,
  ) {}

  async createChat(
    user: AuthenticatedUser,
    input: CreateAiChatDto,
  ): Promise<AiChatResponse> {
    await this.rateLimit.assertChatAllowed(user.id);

    const conversationId = await this.prisma.$transaction(async (tx) => {
      const conversationId = input.conversationId
        ? await this.assertConversationOwnership(tx, input.conversationId, user.id)
        : await this.createConversation(tx, user.id, input);

      await tx.aiMessage.create({
        data: { conversationId, role: 'user', content: input.message },
        select: aiMessageResponseSelect,
      });

      return conversationId;
    });

    const sources = await this.retrieval.retrieve(user, input.message);
    const completion = await this.openai.getClient().chat.completions.create({
      model: this.openai.getModel(),
      messages: [
        { role: 'system', content: AI_TUTOR_SYSTEM_PROMPT },
        { role: 'user', content: buildAiTutorPrompt(input.message, sources) },
      ],
    });
    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new BadGatewayException('AI provider returned an empty response');

    const message = await this.prisma.aiMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content,
        model: this.openai.getModel(),
        tokenCount: completion.usage?.total_tokens,
      },
      select: aiMessageResponseSelect,
    });

    return { conversationId, message, sources };
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
