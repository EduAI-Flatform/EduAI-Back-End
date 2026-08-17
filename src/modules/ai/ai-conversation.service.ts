import {
  BadRequestException,
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatus,
  CourseVisibility,
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { AiRateLimitService } from './ai-rate-limit.service';
import { AiRetrievalService, AiRetrievalSource } from './ai-retrieval.service';
import { AI_TUTOR_SYSTEM_PROMPT, buildAiTutorPrompt } from './ai-prompt-builder';
import { AI_PROVIDER, AiProvider } from './ai-provider';

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
  grounding: 'sourced' | 'general';
}

@Injectable()
export class AiConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AiRateLimitService,
    private readonly retrieval: AiRetrievalService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AiProvider,
  ) {}

  async createChat(
    user: AuthenticatedUser,
    input: CreateAiChatDto,
  ): Promise<AiChatResponse> {
    await this.assertValidContext(user, input);
    await this.rateLimit.assertChatAllowed(user.id);

    const conversationId = await this.prisma.$transaction(async (tx) => {
      const conversationId = input.conversationId
        ? await this.assertConversationOwnership(tx, input.conversationId, user.id, input)
        : await this.createConversation(tx, user.id, input);

      await tx.aiMessage.create({
        data: { conversationId, role: 'user', content: input.message },
        select: aiMessageResponseSelect,
      });

      return conversationId;
    });

    const sources = input.contextType === 'course' && input.contextId
      ? await this.retrieval.retrieve(user, input.message, { courseId: input.contextId })
      : await this.retrieval.retrieve(user, input.message);
    const completion = await this.aiProvider.complete({
      messages: [
        { role: 'system', content: AI_TUTOR_SYSTEM_PROMPT },
        { role: 'user', content: buildAiTutorPrompt(input.message, sources) },
      ],
    });
    const content = completion.content?.trim();
    if (!content) throw new BadGatewayException('AI provider returned an empty response');

    const message = await this.prisma.aiMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content,
        model: this.aiProvider.getModel(),
        tokenCount: completion.totalTokens,
      },
      select: aiMessageResponseSelect,
    });

    return { conversationId, message, sources, grounding: sources.length ? 'sourced' : 'general' };
  }

  private async assertConversationOwnership(
    tx: Prisma.TransactionClient,
    conversationId: string,
    userId: string,
    input: CreateAiChatDto,
  ): Promise<string> {
    const conversation = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true, contextType: true, contextId: true },
    });

    if (!conversation) {
      throw new NotFoundException('AI conversation not found');
    }

    const requestedContextType = input.contextType ?? null;
    const requestedContextId = input.contextId ?? null;
    if (
      conversation.contextType !== requestedContextType ||
      conversation.contextId !== requestedContextId
    ) {
      throw new BadRequestException('AI conversation context cannot be changed');
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

  private async assertValidContext(
    user: AuthenticatedUser,
    input: CreateAiChatDto,
  ): Promise<void> {
    if (!input.contextType && !input.contextId) return;

    if (input.contextType !== 'course' || !input.contextId) {
      throw new BadRequestException('AI course context requires both contextType and contextId');
    }

    if (user.roles.includes(RoleName.platform_admin)) return;

    const course = await this.prisma.course.findFirst({
      where: {
        id: input.contextId,
        deletedAt: null,
        OR: [
          { instructorId: user.id },
          {
            status: CourseStatus.published,
            visibility: CourseVisibility.public,
            moderationStatus: ModerationStatus.clear,
            lessons: { some: { deletedAt: null, isPreview: true } },
          },
          {
            enrollments: {
              some: { userId: user.id, status: { in: ['active', 'completed'] } },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (!course) throw new NotFoundException('AI course context not found');
  }
}
