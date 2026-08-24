import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { AiConversationService } from './ai-conversation.service';

const user: AuthenticatedUser = { id: 'user-id', roles: [RoleName.student] };

describe('AiConversationService', () => {
  function createService() {
    const transaction = {
      aiConversation: { create: jest.fn(), findFirst: jest.fn() },
      aiMessage: { create: jest.fn() },
    };
    const assistantMessage = {
      id: 'assistant-id', role: 'assistant', content: 'Use [Source 1].',
      tokenCount: 12, model: 'gpt-5.4-mini', createdAt: new Date(),
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)),
      aiMessage: { create: jest.fn().mockResolvedValue(assistantMessage) },
      course: { findFirst: jest.fn().mockResolvedValue({ id: 'course-id', lessons: [] }) },
    };
    const quota = { assertChatAllowed: jest.fn() };
    const retrieval = { retrieve: jest.fn().mockResolvedValue([]) };
    const openai = {
      getModel: jest.fn().mockReturnValue('gpt-5.4-mini'),
      complete: jest.fn().mockResolvedValue({
        content: 'Use [Source 1].',
        totalTokens: 12,
      }),
    };
    const courseAccess = { decideContent: jest.fn().mockResolvedValue({ allowed: true }) };

    return { service: new AiConversationService(prisma as never, quota as never, retrieval as never, openai as never, courseAccess as never), prisma, transaction, quota, retrieval, openai, courseAccess };
  }

  const input: CreateAiChatDto = { message: 'Explain recursion.' };

  it('stores the user message, generates an answer, and returns sources', async () => {
    const { service, transaction, quota, retrieval, prisma } = createService();
    transaction.aiConversation.create.mockResolvedValue({ id: 'conversation-id' });
    transaction.aiMessage.create.mockResolvedValue({ id: 'user-message-id' });

    await expect(service.createChat(user, input)).resolves.toEqual({
      conversationId: 'conversation-id',
      message: expect.objectContaining({ id: 'assistant-id', role: 'assistant' }),
      sources: [],
      grounding: 'general',
    });
    expect(quota.assertChatAllowed).toHaveBeenCalledWith(user.id);
    expect(retrieval.retrieve).toHaveBeenCalledWith(user, input.message);
    expect(transaction.aiMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { conversationId: 'conversation-id', role: 'user', content: input.message },
    }));
    expect(prisma.aiMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ conversationId: 'conversation-id', role: 'assistant' }),
    }));
  });

  it('requires an existing conversation to belong to the authenticated user', async () => {
    const { service, transaction } = createService();
    transaction.aiConversation.findFirst.mockResolvedValue(null);

    await expect(service.createChat(user, { ...input, conversationId: 'other-conversation-id' })).rejects.toEqual(
      new NotFoundException('AI conversation not found'),
    );
    expect(transaction.aiMessage.create).not.toHaveBeenCalled();
  });

  it('appends to an owned conversation before generation', async () => {
    const { service, transaction } = createService();
    transaction.aiConversation.findFirst.mockResolvedValue({
      id: 'conversation-id', contextType: null, contextId: null,
    });
    transaction.aiMessage.create.mockResolvedValue({ id: 'user-message-id' });

    await service.createChat(user, { ...input, conversationId: 'conversation-id' });

    expect(transaction.aiConversation.create).not.toHaveBeenCalled();
    expect(transaction.aiConversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conversation-id', userId: user.id },
      select: { id: true, contextType: true, contextId: true },
    });
  });

  it('does not allow an existing conversation scope to change', async () => {
    const { service, transaction } = createService();
    transaction.aiConversation.findFirst.mockResolvedValue({
      id: 'conversation-id', contextType: null, contextId: null,
    });

    await expect(service.createChat(user, {
      ...input,
      conversationId: 'conversation-id',
      contextType: 'course',
      contextId: 'course-id',
    })).rejects.toEqual(new BadRequestException('AI conversation context cannot be changed'));

    expect(transaction.aiMessage.create).not.toHaveBeenCalled();
  });

  it('retrieves only from an authorized selected course', async () => {
    const { service, transaction, retrieval, prisma } = createService();
    transaction.aiConversation.create.mockResolvedValue({ id: 'conversation-id' });
    transaction.aiMessage.create.mockResolvedValue({ id: 'user-message-id' });
    retrieval.retrieve.mockResolvedValue([
      { embeddingId: 'embedding-id', sourceType: 'lesson', sourceId: 'lesson-id' },
    ]);

    await expect(service.createChat(user, {
      ...input,
      contextType: 'course',
      contextId: 'course-id',
    })).resolves.toEqual(expect.objectContaining({ grounding: 'sourced' }));

    expect(prisma.course.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'course-id' }),
      select: expect.objectContaining({ id: true, lessons: expect.any(Object) }),
    }));
    expect(retrieval.retrieve).toHaveBeenCalledWith(user, input.message, { courseId: 'course-id' });
  });

  it('rejects incomplete course context before persisting messages', async () => {
    const { service, transaction, retrieval } = createService();

    await expect(service.createChat(user, { ...input, contextType: 'course' })).rejects.toEqual(
      new BadRequestException('AI course context requires both contextType and contextId'),
    );

    expect(transaction.aiMessage.create).not.toHaveBeenCalled();
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('does not disclose an inaccessible course context', async () => {
    const { service, transaction, prisma } = createService();
    prisma.course.findFirst.mockResolvedValue(null);

    await expect(service.createChat(user, {
      ...input,
      contextType: 'course',
      contextId: 'private-course-id',
    })).rejects.toEqual(new NotFoundException('AI course context not found'));

    expect(transaction.aiMessage.create).not.toHaveBeenCalled();
  });
});
