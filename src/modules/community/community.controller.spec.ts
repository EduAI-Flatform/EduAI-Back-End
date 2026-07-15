import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CommunityController } from './community.controller';

describe('CommunityController', () => {
  it('delegates post commands with the authenticated user', async () => {
    const service = {
      createPost: jest.fn().mockResolvedValue({ id: 'post-id' }),
      updatePost: jest.fn().mockResolvedValue({ id: 'post-id' }),
      deletePost: jest.fn().mockResolvedValue({ success: true }),
      getPost: jest.fn().mockResolvedValue({ id: 'post-id' }),
      listPosts: jest.fn().mockResolvedValue([]),
    };
    const controller = new CommunityController(service as never);
    const user = { id: 'user-id', roles: [RoleName.student] };

    await controller.createPost(user, { title: 'Title', content: 'Content' });
    await controller.updatePost(user, 'post-id', { title: 'Updated' });
    await controller.deletePost(user, 'post-id');

    expect(service.createPost).toHaveBeenCalledWith(user, { title: 'Title', content: 'Content' });
    expect(service.updatePost).toHaveBeenCalledWith(user, 'post-id', { title: 'Updated' });
    expect(service.deletePost).toHaveBeenCalledWith(user, 'post-id');
  });

  it('protects post mutations with JWT authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CommunityController.prototype.createPost)).toBeDefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, CommunityController.prototype.updatePost)).toBeDefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, CommunityController.prototype.deletePost)).toBeDefined();
    expect(Reflect.getMetadata(ROLES_KEY, CommunityController.prototype.createPost)).toBeUndefined();
  });
});
