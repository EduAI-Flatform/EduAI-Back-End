import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AiController } from './ai.controller';

describe('AiController', () => {
  it('delegates chat requests with the authenticated user', async () => {
    const service = { createChat: jest.fn().mockResolvedValue({ conversationId: 'conversation-id' }) };
    const controller = new AiController(service as never, {} as never, {} as never);
    const user = { id: 'user-id', roles: [] };
    const input = { message: 'Hello AI' };

    await expect(controller.createChat(user, input)).resolves.toEqual({
      conversationId: 'conversation-id',
    });
    expect(service.createChat).toHaveBeenCalledWith(user, input);
  });

  it('delegates summary requests with the authenticated user', async () => {
    const chat = { createChat: jest.fn() };
    const summary = { summarize: jest.fn().mockResolvedValue({ sourceType: 'lesson', summary: 'Summary' }) };
    const controller = new AiController(chat as never, summary as never, {} as never);
    const user = { id: 'user-id', roles: [] };
    const input = { sourceType: 'lesson' as const, sourceId: 'lesson-id' };

    await expect(controller.createSummary(user, input)).resolves.toEqual({ sourceType: 'lesson', summary: 'Summary' });
    expect(summary.summarize).toHaveBeenCalledWith(user, input);
  });

  it('protects chat with JWT authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.createChat)).toBeDefined();
  });

  it('protects summary with JWT authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.createSummary)).toBeDefined();
  });
});
