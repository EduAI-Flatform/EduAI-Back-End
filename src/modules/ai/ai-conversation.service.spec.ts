import { NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateAiChatDto } from './dto/create-ai-chat.dto';
import { AiConversationService } from './ai-conversation.service';

const user: AuthenticatedUser = { id: 'user-id', roles: [RoleName.student] };

describe('AiConversationService', () => {
  function createService() {
    const transaction = {
      aiConversation: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      aiMessage: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    };
    const quota = { assertChatAllowed: jest.fn() };

    return {
      service: new AiConversationService(prisma as never, quota as never),
      prisma,
      transaction,
      quota,
    };
  }

  const input: CreateAiChatDto = { message: 'Explain recursion.' };

  it('creates a conversation and stores the authenticated user message', async () => {
    const { service, transaction, quota } = createService();
    transaction.aiConversation.create.mockResolvedValue({ id: 'conversation-id' });
    transaction.aiMessage.create.mockResolvedValue({
      id: 'message-id',
      role: 'user',
      content: input.message,
      tokenCount: null,
      model: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
    });

    await expect(service.createChat(user, input)).resolves.toEqual({
      conversationId: 'conversation-id',
      message: expect.objectContaining({ id: 'message-id', role: 'user' }),
    });

    expect(quota.assertChatAllowed).toHaveBeenCalledWith(user.id);
    expect(transaction.aiConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: user.id }),
        select: { id: true },
      }),
    );
    expect(transaction.aiMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { conversationId: 'conversation-id', role: 'user', content: input.message },
        select: expect.any(Object),
      }),
    );
  });

  it('requires an existing conversation to belong to the authenticated user', async () => {
    const { service, transaction } = createService();
    transaction.aiConversation.findFirst.mockResolvedValue(null);

    await expect(
      service.createChat(user, { ...input, conversationId: 'other-conversation-id' }),
    ).rejects.toEqual(new NotFoundException('AI conversation not found'));
    expect(transaction.aiMessage.create).not.toHaveBeenCalled();
  });

  it('appends a message to the authenticated user conversation', async () => {
    const { service, transaction } = createService();
    transaction.aiConversation.findFirst.mockResolvedValue({ id: 'conversation-id' });
    transaction.aiMessage.create.mockResolvedValue({
      id: 'message-id', role: 'user', content: input.message, tokenCount: null, model: null,
      createdAt: new Date(),
    });

    await service.createChat(user, { ...input, conversationId: 'conversation-id' });

    expect(transaction.aiConversation.create).not.toHaveBeenCalled();
    expect(transaction.aiConversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conversation-id', userId: user.id },
      select: { id: true },
    });
  });
});
