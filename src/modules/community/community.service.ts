import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCommunityPostDto } from './dto/create-community-post.dto';
import { UpdateCommunityPostDto } from './dto/update-community-post.dto';

const communityPostResponseSelect = {
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
} satisfies Prisma.CommunityPostSelect;

type CommunityPostResponse = Prisma.CommunityPostGetPayload<{
  select: typeof communityPostResponseSelect;
}>;

export interface CommunitySuccessResponse {
  success: true;
  message: string;
}

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  listPosts(): Promise<CommunityPostResponse[]> {
    return this.prisma.communityPost.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        visibility: 'public',
      },
      orderBy: { createdAt: 'desc' },
      select: communityPostResponseSelect,
    });
  }

  async getPost(id: string): Promise<CommunityPostResponse> {
    const post = await this.prisma.communityPost.findFirst({
      where: {
        id,
        deletedAt: null,
        status: 'active',
        visibility: 'public',
      },
      select: communityPostResponseSelect,
    });

    if (!post) {
      throw new NotFoundException('Community post not found');
    }

    return post;
  }

  createPost(
    user: AuthenticatedUser,
    input: CreateCommunityPostDto,
  ): Promise<CommunityPostResponse> {
    return this.prisma.communityPost.create({
      data: {
        authorId: user.id,
        title: input.title,
        content: input.content,
        visibility: input.visibility ?? 'public',
        status: 'active',
      },
      select: communityPostResponseSelect,
    });
  }

  async updatePost(
    user: AuthenticatedUser,
    id: string,
    input: UpdateCommunityPostDto,
  ): Promise<CommunityPostResponse> {
    const post = await this.findManageablePost(id);
    const isAdmin = this.isAdmin(user);

    if (post.authorId !== user.id && !isAdmin) {
      throw new NotFoundException('Community post not found');
    }

    if (input.status !== undefined && !isAdmin) {
      throw new ForbiddenException('Only admins can moderate community posts');
    }

    const data = Object.fromEntries(
      Object.entries({
        title: input.title,
        content: input.content,
        visibility: input.visibility,
        status: input.status,
      }).filter(([, value]) => value !== undefined),
    );

    return this.prisma.communityPost.update({
      where: { id },
      data,
      select: communityPostResponseSelect,
    });
  }

  async deletePost(
    user: AuthenticatedUser,
    id: string,
  ): Promise<CommunitySuccessResponse> {
    const post = await this.findManageablePost(id);

    if (post.authorId !== user.id && !this.isAdmin(user)) {
      throw new NotFoundException('Community post not found');
    }

    await this.prisma.communityPost.update({
      where: { id },
      data: {
        status: 'removed',
        deletedAt: new Date(),
      },
    });

    return {
      success: true,
      message: 'Community post deleted successfully',
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

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes(RoleName.platform_admin);
  }
}
