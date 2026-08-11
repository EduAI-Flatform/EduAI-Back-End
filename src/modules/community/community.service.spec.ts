import { NotFoundException } from '@nestjs/common';
import { ModerationStatus, RoleName } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CommunityService } from './community.service';

const student: AuthenticatedUser = { id: 'student-id', roles: [RoleName.student] };
const admin: AuthenticatedUser = { id: 'admin-id', roles: [RoleName.platform_admin] };

describe('CommunityService', () => {
  function createService() {
    let prisma: Record<string, any>;
    prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
        callback(prisma),
      ),
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
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    return {
      auditService,
      service: new CommunityService(prisma as never, auditService as never),
      prisma,
    };
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
    ).resolves.toEqual({
      ...post,
      reactionCount: 0,
      commentCount: 0,
      viewerHasLiked: false,
    });

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

    await service.listPosts(undefined);

    expect(prisma.communityPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          status: 'active',
          visibility: 'public',
          moderationStatus: ModerationStatus.clear,
        },
        select: expect.any(Object),
      }),
    );
  });

  it('returns aggregate counters and the authenticated viewer like state without N+1 queries', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findMany.mockResolvedValue([
      {
        id: 'post-1',
        title: 'Study group',
        content: 'Discuss AI.',
        visibility: 'public',
        status: 'active',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        author: {
          id: 'author-id',
          fullName: 'Demo Author',
          avatarUrl: null,
        },
        _count: { reactions: 3, comments: 2 },
      },
      {
        id: 'post-2',
        title: 'Second post',
        content: 'More discussion.',
        visibility: 'public',
        status: 'active',
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
        author: {
          id: 'author-id',
          fullName: 'Demo Author',
          avatarUrl: null,
        },
        _count: { reactions: 1, comments: 0 },
      },
    ]);
    prisma.communityReaction.findMany.mockResolvedValue([{ postId: 'post-2' }]);

    await expect(service.listPosts(student)).resolves.toEqual([
      expect.objectContaining({
        id: 'post-1',
        reactionCount: 3,
        commentCount: 2,
        viewerHasLiked: false,
      }),
      expect.objectContaining({
        id: 'post-2',
        reactionCount: 1,
        commentCount: 0,
        viewerHasLiked: true,
      }),
    ]);
    expect(prisma.communityReaction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.communityReaction.findMany).toHaveBeenCalledWith({
      where: {
        postId: { in: ['post-1', 'post-2'] },
        userId: student.id,
        type: 'like',
      },
      select: { postId: true },
    });
  });

  it('does not query viewer reactions for anonymous community reads', async () => {
    const { service, prisma } = createService();
    prisma.communityPost.findMany.mockResolvedValue([
      {
        id: 'post-id',
        title: 'Study group',
        content: 'Discuss AI.',
        visibility: 'public',
        status: 'active',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        author: {
          id: 'author-id',
          fullName: 'Demo Author',
          avatarUrl: null,
        },
        _count: { reactions: 2, comments: 1 },
      },
    ]);

    await expect(service.listPosts(undefined)).resolves.toEqual([
      expect.objectContaining({
        reactionCount: 2,
        commentCount: 1,
        viewerHasLiked: false,
      }),
    ]);
    expect(prisma.communityReaction.findMany).not.toHaveBeenCalled();
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

  it('keeps general post edits separate from moderation transitions', async () => {
    const { auditService, service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityPost.update.mockResolvedValue({ id: 'post-id', title: 'Reviewed title' });

    await service.updatePost(admin, 'post-id', { title: 'Reviewed title' });

    expect(prisma.communityPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Reviewed title' } }),
    );
    expect(auditService.record).not.toHaveBeenCalled();
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

  it('audits an administrator removing a community post', async () => {
    const { auditService, service, prisma } = createService();
    prisma.communityPost.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityPost.update.mockResolvedValue(undefined);

    await service.deletePost(admin, 'post-id');

    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: admin.id,
        action: AuditAction.CommunityPostRemoved,
        target: { type: 'community_post', id: 'post-id' },
        metadata: { status: 'removed' },
      },
      prisma,
    );
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
          moderationStatus: ModerationStatus.clear,
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
        where: {
          postId: 'post-id',
          deletedAt: null,
          status: 'active',
          moderationStatus: ModerationStatus.clear,
        },
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

  it('audits an administrator removing a community comment', async () => {
    const { auditService, service, prisma } = createService();
    prisma.communityComment.findFirst.mockResolvedValue({ authorId: student.id });
    prisma.communityComment.update.mockResolvedValue(undefined);

    await service.deleteComment(admin, 'comment-id');

    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: admin.id,
        action: AuditAction.CommunityCommentRemoved,
        target: { type: 'community_comment', id: 'comment-id' },
        metadata: { status: 'removed' },
      },
      prisma,
    );
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
