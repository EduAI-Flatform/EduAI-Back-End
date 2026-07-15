import { NotFoundException } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CommunityService } from './community.service';

const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };
const admin: AuthenticatedUser = { id: 'admin-id', roles: [RoleName.platform_admin] };

describe('CommunityService', () => {
  function createService() {
    const prisma = {
      communityPost: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    return { service: new CommunityService(prisma as never), prisma };
  }

  it('creates a post for the authenticated user with an explicit projection', async () => {
    const { service, prisma } = createService();
    const post = { id: 'post-id', title: 'Study group', content: 'Discuss AI.' };
    prisma.communityPost.create.mockResolvedValue(post);

    await expect(
      service.createPost(student, {
        title: 'Study group',
        content: 'Discuss AI.',
      }),
    ).resolves.toEqual(post);

    expect(prisma.communityPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          authorId: student.id,
          title: 'Study group',
          content: 'Discuss AI.',
          visibility: 'public',
          status: 'active',
        },
        select: expect.any(Object),
      }),
    );
  });

  it('lists only active public posts and excludes deleted content', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findMany.mockResolvedValue([]);

    await service.listPosts();

    expect(prisma.communityPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, status: 'active', visibility: 'public' },
        select: expect.any(Object),
      }),
    );
  });

  it('allows an author to update their post', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityPost.update.mockResolvedValue({ id: 'post-id', title: 'Updated' });

    await service.updatePost(student, 'post-id', { title: 'Updated' });

    expect(prisma.communityPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-id' },
        data: { title: 'Updated' },
      }),
    );
  });

  it('allows an admin to update another user post and hide it', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityPost.update.mockResolvedValue({ id: 'post-id', status: 'hidden' });

    await service.updatePost(admin, 'post-id', { status: 'hidden' });

    expect(prisma.communityPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'hidden' } }),
    );
  });

  it('does not allow another user to update a post', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: 'other-user-id' });

    await expect(service.updatePost(student, 'post-id', { title: 'Nope' })).rejects.toEqual(
      new NotFoundException('Community post not found'),
    );
    expect(prisma.communityPost.update).not.toHaveBeenCalled();
  });

  it('soft-deletes a post for its author', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityPost.update.mockResolvedValue(undefined);

    await expect(service.deletePost(student, 'post-id')).resolves.toEqual({
      success: true,
      message: 'Community post deleted successfully',
    });
    expect(prisma.communityPost.update).toHaveBeenCalledWith({
      where: { id: 'post-id' },
      data: { status: 'removed', deletedAt: expect.any(Date) },
    });
  });
});
