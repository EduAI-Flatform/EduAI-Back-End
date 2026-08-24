import {
  BadRequestException,
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CourseAccessService } from '../access/course-access.service';
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
    private readonly courseAccess: CourseAccessService,
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

    const course = await this.prisma.course.findFirst({
      where: {
        id: input.contextId,
        deletedAt: null,
      },
      select: { id: true, lessons: { where: { deletedAt: null, isPreview: true }, select: { id: true }, take: 1 } },
    });
    if (!course) throw new NotFoundException('AI course context not found');
    const decision = await this.courseAccess.decideContent({
      user,
      courseId: course.id,
      isPreviewResource: course.lessons.length > 0,
    });
    if (!decision.allowed) throw new NotFoundException('AI course context not found');
  }
}
