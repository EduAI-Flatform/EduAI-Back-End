import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AiController } from './ai.controller';

describe('AiController', () => {
  it('delegates chat requests with the authenticated user', async () => {
    const service = { createChat: jest.fn().mockResolvedValue({ conversationId: 'conversation-id' }) };
    const controller = new AiController(
      service as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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
    const controller = new AiController(
      chat as never,
      summary as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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

  it('delegates source listing and protects it with JWT authentication', async () => {
    const sources = {
      listSources: jest.fn().mockResolvedValue([{ sourceId: 'lesson-id' }]),
    };
    const controller = new AiController(
      {} as never,
      {} as never,
      {} as never,
      sources as never,
      {} as never,
      {} as never,
    );
    const user = { id: 'user-id', roles: [] };
    const query = { sourceType: 'lesson' as const };

    await expect(controller.listSources(user, query)).resolves.toEqual([
      { sourceId: 'lesson-id' },
    ]);
    expect(sources.listSources).toHaveBeenCalledWith(user, query);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        AiController.prototype.listSources,
      ),
    ).toBeDefined();
  });

  it('delegates learning-path regeneration and protects it with JWT authentication', async () => {
    const learningPath = { regenerate: jest.fn().mockResolvedValue({ id: 'path-id', version: 1 }) };
    const controller = new AiController({} as never, {} as never, {} as never, {} as never, learningPath as never, {} as never);
    const user = { id: 'user-id', roles: [] };
    await expect(controller.regenerateLearningPath(user)).resolves.toEqual({ id: 'path-id', version: 1 });
    expect(learningPath.regenerate).toHaveBeenCalledWith(user);
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.regenerateLearningPath)).toBeDefined();
  });

  it('delegates current learning-path reads and protects them with JWT authentication', async () => {
    const learningPath = { getCurrent: jest.fn().mockResolvedValue({ id: 'path-id', version: 1 }) };
    const controller = new AiController({} as never, {} as never, {} as never, {} as never, learningPath as never, {} as never);
    const user = { id: 'user-id', roles: [] };

    await expect(controller.getCurrentLearningPath(user)).resolves.toEqual({ id: 'path-id', version: 1 });
    expect(learningPath.getCurrent).toHaveBeenCalledWith(user);
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.getCurrentLearningPath)).toBeDefined();
  });

  it('delegates embedding rebuilds only to platform administrators', async () => {
    const embeddings = { rebuildAll: jest.fn().mockResolvedValue({ lessons: 1, libraryResources: 1, chunkCount: 2 }) };
    const controller = new AiController({} as never, {} as never, {} as never, {} as never, {} as never, embeddings as never);
    const user = { id: 'admin-id', roles: [RoleName.platform_admin] };

    await expect(controller.rebuildEmbeddings(user)).resolves.toEqual({ lessons: 1, libraryResources: 1, chunkCount: 2 });
    expect(embeddings.rebuildAll).toHaveBeenCalledWith(user);
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController.prototype.rebuildEmbeddings)).toBeDefined();
    expect(Reflect.getMetadata(ROLES_KEY, AiController.prototype.rebuildEmbeddings)).toEqual([RoleName.platform_admin]);
  });
});
