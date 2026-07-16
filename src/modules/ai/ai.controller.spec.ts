import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AiController } from './ai.controller';

describe('AiController', () => {
  it('delegates chat requests with the authenticated user', async () => {
    const service = { createChat: jest.fn().mockResolvedValue({ conversationId: 'conversation-id' }) };
    const controller = new AiController(service as never);
    const user = { id: 'user-id', roles: [] };
    const input = { message: 'Hello AI' };

    await expect(controller.createChat(user, input)).resolves.toEqual({
      conversationId: 'conversation-id',
    });
    expect(service.createChat).toHaveBeenCalledWith(user, input);
  });

  it('protects chat with JWT authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.createChat)).toBeDefined();
  });
});
