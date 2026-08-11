import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCommunityPostDto } from './dto/create-community-post.dto';
import { CreateCommunityCommentDto } from './dto/create-community-comment.dto';
import { UpdateCommunityPostDto } from './dto/update-community-post.dto';

const communityPostRecordSelect = {
  id: true,
  title: true,
  content: true,
  visibility: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
    },
  },
  _count: {
    select: {
      reactions: {
        where: {
          type: 'like',
        },
      },
      comments: {
        where: {
          deletedAt: null,
          status: 'active',
          moderationStatus: ModerationStatus.clear,
        },
      },
    },
  },
} satisfies Prisma.CommunityPostSelect;

const communityCommentResponseSelect = {
  id: true,
  postId: true,
  parentId: true,
  content: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.CommunityCommentSelect;

type CommunityPostRecord = Prisma.CommunityPostGetPayload<{
  select: typeof communityPostRecordSelect;
}>;

export type CommunityPostResponse = Omit<CommunityPostRecord, '_count'> & {
  reactionCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
};

type CommunityCommentResponse = Prisma.CommunityCommentGetPayload<{
  select: typeof communityCommentResponseSelect;
}>;

export interface CommunitySuccessResponse {
  success: true;
  message: string;
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listPosts(
    user: AuthenticatedUser | undefined,
  ): Promise<CommunityPostResponse[]> {
    const posts = await this.prisma.communityPost.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        visibility: 'public',
        moderationStatus: ModerationStatus.clear,
      },
      orderBy: { createdAt: 'desc' },
      select: communityPostRecordSelect,
    });

    return this.toCommunityPostResponses(posts, user?.id);
  }

  async getPost(
    user: AuthenticatedUser | undefined,
    id: string,
  ): Promise<CommunityPostResponse> {
    const post = await this.prisma.communityPost.findFirst({
      where: {
        id,
        deletedAt: null,
        status: 'active',
        visibility: 'public',
        moderationStatus: ModerationStatus.clear,
      },
      select: communityPostRecordSelect,
    });

    if (!post) {
      throw new NotFoundException('Community post not found');
    }

    return (await this.toCommunityPostResponses([post], user?.id))[0];
  }

  async createPost(
    user: AuthenticatedUser,
    input: CreateCommunityPostDto,
  ): Promise<CommunityPostResponse> {
    const post = await this.prisma.communityPost.create({
      data: {
        authorId: user.id,
        title: input.title,
        content: input.content,
        visibility: input.visibility ?? 'public',
        status: 'active',
      },
      select: communityPostRecordSelect,
    });

    return this.toCommunityPostResponse(post, false);
  }

  async updatePost(
    user: AuthenticatedUser,
    id: string,
    input: UpdateCommunityPostDto,
  ): Promise<CommunityPostResponse> {
    const post = await this.findManageablePost(id);
    if (post.authorId !== user.id && !this.isAdmin(user)) {
      throw new NotFoundException('Community post not found');
    }

    const data = Object.fromEntries(
      Object.entries({
        title: input.title,
        content: input.content,
        visibility: input.visibility,
      }).filter(([, value]) => value !== undefined),
    );

    const updatedPost = await this.prisma.communityPost.update({
      where: { id },
      data,
      select: communityPostRecordSelect,
    });
    const [response] = await this.toCommunityPostResponses(
      [updatedPost],
      user.id,
    );
    return response;
  }

  async deletePost(
    user: AuthenticatedUser,
    id: string,
  ): Promise<CommunitySuccessResponse> {
    const post = await this.findManageablePost(id);

    if (post.authorId !== user.id && !this.isAdmin(user)) {
      throw new NotFoundException('Community post not found');
    }

    const remove = (client: Pick<Prisma.TransactionClient, 'communityPost'>) =>
      client.communityPost.update({
        where: { id },
        data: {
          status: 'removed',
          deletedAt: new Date(),
        },
      });

    if (this.isAdmin(user)) {
      await this.prisma.$transaction(async (tx) => {
        await remove(tx);
        await this.auditService.record(
          {
            actorId: user.id,
            action: AuditAction.CommunityPostRemoved,
            target: { type: 'community_post', id },
            metadata: { status: 'removed' },
          },
          tx,
        );
      });
    } else {
      await remove(this.prisma);
    }

    return {
      success: true,
      message: 'Community post deleted successfully',
    };
  }

  async listComments(postId: string): Promise<CommunityCommentResponse[]> {
    await this.findVisiblePost(postId);

    return this.prisma.communityComment.findMany({
      where: {
        postId,
        deletedAt: null,
        status: 'active',
        moderationStatus: ModerationStatus.clear,
      },
      orderBy: { createdAt: 'asc' },
      select: communityCommentResponseSelect,
    });
  }

  async createComment(
    user: AuthenticatedUser,
    postId: string,
    input: CreateCommunityCommentDto,
  ): Promise<CommunityCommentResponse> {
    await this.findVisiblePost(postId);

    if (input.parentId) {
      const parent = await this.prisma.communityComment.findFirst({
        where: {
          id: input.parentId,
          postId,
          deletedAt: null,
          status: 'active',
          moderationStatus: ModerationStatus.clear,
        },
        select: { id: true },
      });

      if (!parent) {
        throw new NotFoundException('Parent community comment not found');
      }
    }

    return this.prisma.communityComment.create({
      data: {
        postId,
        authorId: user.id,
        parentId: input.parentId ?? null,
        content: input.content,
        status: 'active',
      },
      select: communityCommentResponseSelect,
    });
  }

  async deleteComment(
    user: AuthenticatedUser,
    id: string,
  ): Promise<CommunitySuccessResponse> {
    const comment = await this.prisma.communityComment.findFirst({
      where: { id, deletedAt: null },
      select: { authorId: true },
    });

    if (!comment || (comment.authorId !== user.id && !this.isAdmin(user))) {
      throw new NotFoundException('Community comment not found');
    }

    const remove = (
      client: Pick<Prisma.TransactionClient, 'communityComment'>,
    ) =>
      client.communityComment.update({
        where: { id },
        data: {
          status: 'removed',
          deletedAt: new Date(),
        },
      });

    if (this.isAdmin(user)) {
      await this.prisma.$transaction(async (tx) => {
        await remove(tx);
        await this.auditService.record(
          {
            actorId: user.id,
            action: AuditAction.CommunityCommentRemoved,
            target: { type: 'community_comment', id },
            metadata: { status: 'removed' },
          },
          tx,
        );
      });
    } else {
      await remove(this.prisma);
    }

    return {
      success: true,
      message: 'Community comment deleted successfully',
    };
  }

  async likePost(
    user: AuthenticatedUser,
    postId: string,
  ): Promise<CommunitySuccessResponse> {
    await this.findVisiblePost(postId);

    try {
      await this.prisma.communityReaction.create({
        data: {
          postId,
          userId: user.id,
          type: 'like',
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.isDuplicateReaction(error)) {
        throw new ConflictException('Community post already liked');
      }
      throw error;
    }

    return {
      success: true,
      message: 'Community post liked successfully',
    };
  }

  async unlikePost(
    user: AuthenticatedUser,
    postId: string,
  ): Promise<CommunitySuccessResponse> {
    await this.findVisiblePost(postId);

    await this.prisma.communityReaction.deleteMany({
      where: {
        postId,
        userId: user.id,
        type: 'like',
      },
    });

    return {
      success: true,
      message: 'Community post unliked successfully',
    };
  }

  private findManageablePost(id: string): Promise<{ authorId: string }> {
    return this.prisma.communityPost.findFirst({
      where: { id, deletedAt: null },
      select: { authorId: true },
    }).then((post) => {
      if (!post) {
        throw new NotFoundException('Community post not found');
      }
      return post;
    });
  }

  private async findVisiblePost(id: string): Promise<{ id: string }> {
    const post = await this.prisma.communityPost.findFirst({
      where: {
        id,
        deletedAt: null,
        status: 'active',
        visibility: 'public',
        moderationStatus: ModerationStatus.clear,
      },
      select: { id: true },
    });

    if (!post) {
      throw new NotFoundException('Community post not found');
    }

    return post;
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes(RoleName.platform_admin);
  }

  private isDuplicateReaction(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private async toCommunityPostResponses(
    posts: CommunityPostRecord[],
    viewerId: string | undefined,
  ): Promise<CommunityPostResponse[]> {
    if (!viewerId || posts.length === 0) {
      return posts.map((post) => this.toCommunityPostResponse(post, false));
    }

    const reactions = await this.prisma.communityReaction.findMany({
      where: {
        postId: { in: posts.map((post) => post.id) },
        userId: viewerId,
        type: 'like',
      },
      select: { postId: true },
    });
    const likedPostIds = new Set(reactions.map((reaction) => reaction.postId));

    return posts.map((post) =>
      this.toCommunityPostResponse(post, likedPostIds.has(post.id)),
    );
  }

  private toCommunityPostResponse(
    post: CommunityPostRecord,
    viewerHasLiked: boolean,
  ): CommunityPostResponse {
    const { _count, ...response } = post;

    return {
      ...response,
      reactionCount: _count?.reactions ?? 0,
      commentCount: _count?.comments ?? 0,
      viewerHasLiked,
    };
  }
}
