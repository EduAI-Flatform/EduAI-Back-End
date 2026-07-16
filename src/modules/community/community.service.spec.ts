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
      communityComment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      communityReaction: {
        create: jest.fn(),
        deleteMany: jest.fn(),
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

  it('creates a nested comment only when its parent belongs to the same post', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'post-id' });
    prisma.communityComment.findFirst.mockResolvedValue({ id: 'parent-id' });
    prisma.communityComment.create.mockResolvedValue({
      id: 'reply-id',
      postId: 'post-id',
      parentId: 'parent-id',
    });

    await service.createComment(student, 'post-id', {
      content: 'A reply',
      parentId: 'parent-id',
    });

    expect(prisma.communityComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          postId: 'post-id',
          authorId: student.id,
          parentId: 'parent-id',
          content: 'A reply',
          status: 'active',
        },
        select: expect.any(Object),
      }),
    );
    expect(prisma.communityComment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'parent-id',
          postId: 'post-id',
          deletedAt: null,
          status: 'active',
        },
      }),
    );
  });

  it('lists active comments for a visible post in creation order', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'post-id' });
    prisma.communityComment.findMany.mockResolvedValue([]);

    await service.listComments('post-id');

    expect(prisma.communityComment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: 'post-id', deletedAt: null, status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: expect.any(Object),
      }),
    );
  });

  it('allows only the comment author or admin to delete a comment', async () => {
    const { service, prisma } = createService();
    prisma.communityComment.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityComment.update.mockResolvedValue(undefined);

    await expect(service.deleteComment(student, 'comment-id')).resolves.toEqual({
      success: true,
      message: 'Community comment deleted successfully',
    });
    expect(prisma.communityComment.update).toHaveBeenCalledWith({
      where: { id: 'comment-id' },
      data: { status: 'removed', deletedAt: expect.any(Date) },
    });
  });

  it('creates one like for an authenticated user and returns a compact command response', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'post-id' });
    prisma.communityReaction.create.mockResolvedValue({ id: 'reaction-id' });

    await expect(service.likePost(student, 'post-id')).resolves.toEqual({
      success: true,
      message: 'Community post liked successfully',
    });
    expect(prisma.communityReaction.create).toHaveBeenCalledWith({
      data: { postId: 'post-id', userId: student.id, type: 'like' },
      select: { id: true },
    });
  });

  it('removes the authenticated user like without affecting other reactions', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'post-id' });
    prisma.communityReaction.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.unlikePost(student, 'post-id')).resolves.toEqual({
      success: true,
      message: 'Community post unliked successfully',
    });
    expect(prisma.communityReaction.deleteMany).toHaveBeenCalledWith({
      where: { postId: 'post-id', userId: student.id, type: 'like' },
    });
  });

  it('maps a duplicate database like to a conflict response', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'post-id' });
    prisma.communityReaction.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.likePost(student, 'post-id')).rejects.toThrow(
      'Community post already liked',
    );
  });
});
