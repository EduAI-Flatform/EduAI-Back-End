import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import {
  AuditLogResponse,
  AuditService,
} from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  ModerationAction,
  ModerationActionValue,
  ModerationTargetType,
  ModerationTargetTypeValue,
} from './moderation.constants';

export { ModerationAction, ModerationTargetType } from './moderation.constants';

const ownerSelect = {
  id: true,
  fullName: true,
} satisfies Prisma.UserSelect;

const courseSelect = {
  id: true,
  title: true,
  description: true,
  moderationStatus: true,
  moderationReason: true,
  moderatedAt: true,
  createdAt: true,
  updatedAt: true,
  instructor: { select: ownerSelect },
} satisfies Prisma.CourseSelect;

const libraryResourceSelect = {
  id: true,
  title: true,
  description: true,
  moderationStatus: true,
  moderationReason: true,
  moderatedAt: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: ownerSelect },
} satisfies Prisma.LibraryResourceSelect;

const communityPostSelect = {
  id: true,
  title: true,
  content: true,
  moderationStatus: true,
  moderationReason: true,
  moderatedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: ownerSelect },
} satisfies Prisma.CommunityPostSelect;

const communityCommentSelect = {
  id: true,
  content: true,
  moderationStatus: true,
  moderationReason: true,
  moderatedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: ownerSelect },
  post: { select: { title: true } },
} satisfies Prisma.CommunityCommentSelect;

const moderationStatusSelect = {
  id: true,
  moderationStatus: true,
  moderationReason: true,
  moderatedAt: true,
} as const;

type ModerationClient = Pick<
  Prisma.TransactionClient,
  'course' | 'libraryResource' | 'communityPost' | 'communityComment'
>;

interface NormalizedModerationRecord {
  id: string;
  title: string;
  content: string | null;
  owner: { id: string; fullName: string };
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModerationItemResponse extends NormalizedModerationRecord {
  targetType: ModerationTargetTypeValue;
}

export interface ListModerationQuery {
  targetType: ModerationTargetTypeValue;
  status?: ModerationStatus;
  search?: string;
  page: number;
  pageSize: number;
}

export interface PaginatedModerationResponse {
  items: ModerationItemResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ModerationDetailResponse {
  item: ModerationItemResponse;
  history: AuditLogResponse[];
}

export interface ModerationCommand {
  action: ModerationActionValue;
  reason: string;
}

export interface ModerationStatusResponse {
  id: string;
  targetType: ModerationTargetTypeValue;
  moderationStatus: ModerationStatus;
  moderationReason: string | null;
  moderatedAt: Date | null;
}

const ALLOWED_ACTIONS: Record<
  ModerationTargetTypeValue,
  readonly ModerationActionValue[]
> = {
  [ModerationTargetType.Course]: [
    ModerationAction.Reject,
    ModerationAction.Archive,
    ModerationAction.Restore,
  ],
  [ModerationTargetType.LibraryResource]: [
    ModerationAction.Hide,
    ModerationAction.Reject,
    ModerationAction.Archive,
    ModerationAction.Restore,
  ],
  [ModerationTargetType.CommunityPost]: [
    ModerationAction.Hide,
    ModerationAction.Reject,
    ModerationAction.Restore,
  ],
  [ModerationTargetType.CommunityComment]: [
    ModerationAction.Hide,
    ModerationAction.Reject,
    ModerationAction.Restore,
  ],
};

const ACTION_STATUS: Record<ModerationActionValue, ModerationStatus> = {
  [ModerationAction.Hide]: ModerationStatus.hidden,
  [ModerationAction.Reject]: ModerationStatus.rejected,
  [ModerationAction.Archive]: ModerationStatus.archived,
  [ModerationAction.Restore]: ModerationStatus.clear,
};

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  list(query: ListModerationQuery): Promise<PaginatedModerationResponse> {
    switch (query.targetType) {
      case ModerationTargetType.Course:
        return this.listCourses(query);
      case ModerationTargetType.LibraryResource:
        return this.listLibraryResources(query);
      case ModerationTargetType.CommunityPost:
        return this.listCommunityPosts(query);
      case ModerationTargetType.CommunityComment:
        return this.listCommunityComments(query);
    }
  }

  async getDetail(
    targetType: ModerationTargetTypeValue,
    targetId: string,
  ): Promise<ModerationDetailResponse> {
    const item = await this.findTarget(this.prisma, targetType, targetId);
    const history = await this.auditService.listTargetHistory(
      targetType,
      targetId,
      50,
    );
    return { item: { ...item, targetType }, history };
  }

  async moderate(
    actorId: string,
    targetType: ModerationTargetTypeValue,
    targetId: string,
    command: ModerationCommand,
  ): Promise<ModerationItemResponse> {
    if (!ALLOWED_ACTIONS[targetType].includes(command.action)) {
      throw new BadRequestException(
        `Action ${command.action} is not supported for ${targetType}`,
      );
    }

    const nextStatus = ACTION_STATUS[command.action];
    return this.prisma.$transaction(async (tx) => {
      const current = await this.findTarget(tx, targetType, targetId);
      if (current.moderationStatus === nextStatus) {
        throw new BadRequestException(
          `Target is already ${current.moderationStatus}`,
        );
      }

      const updated = await this.updateTarget(tx, targetType, targetId, {
        moderationStatus: nextStatus,
        moderationReason: command.reason,
        moderatedAt: new Date(),
      });
      await this.auditService.record(
        {
          actorId,
          action: AuditAction.ContentModerationChanged,
          target: { type: targetType, id: targetId },
          metadata: {
            action: command.action,
            previousStatus: current.moderationStatus,
            newStatus: nextStatus,
            reason: command.reason,
          },
        },
        tx,
      );

      return { ...updated, targetType };
    });
  }

  async getOwnerStatus(
    user: AuthenticatedUser,
    targetType: ModerationTargetTypeValue,
    targetId: string,
  ): Promise<ModerationStatusResponse> {
    const isAdmin = user.roles.includes(RoleName.platform_admin);
    const ownerWhere = isAdmin ? {} : this.ownerWhere(targetType, user.id);
    const record = await this.findStatus(targetType, targetId, ownerWhere);
    if (!record) throw new NotFoundException('Moderation target not found');
    return { ...record, targetType };
  }

  private async listCourses(
    query: ListModerationQuery,
  ): Promise<PaginatedModerationResponse> {
    const where: Prisma.CourseWhereInput = {
      deletedAt: null,
      ...(query.status ? { moderationStatus: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              {
                description: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
    const [total, records] = await this.prisma.$transaction([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: this.skip(query),
        take: query.pageSize,
        select: courseSelect,
      }),
    ]);
    return this.page(
      records.map((record) => ({
        ...this.normalizeCourse(record, true),
        targetType: ModerationTargetType.Course,
      })),
      total,
      query,
    );
  }

  private async listLibraryResources(
    query: ListModerationQuery,
  ): Promise<PaginatedModerationResponse> {
    const where: Prisma.LibraryResourceWhereInput = {
      deletedAt: null,
      ...(query.status ? { moderationStatus: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              {
                description: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
    const [total, records] = await this.prisma.$transaction([
      this.prisma.libraryResource.count({ where }),
      this.prisma.libraryResource.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: this.skip(query),
        take: query.pageSize,
        select: libraryResourceSelect,
      }),
    ]);
    return this.page(
      records.map((record) => ({
        ...this.normalizeLibraryResource(record, true),
        targetType: ModerationTargetType.LibraryResource,
      })),
      total,
      query,
    );
  }

  private async listCommunityPosts(
    query: ListModerationQuery,
  ): Promise<PaginatedModerationResponse> {
    const where: Prisma.CommunityPostWhereInput = {
      deletedAt: null,
      ...(query.status ? { moderationStatus: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { content: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, records] = await this.prisma.$transaction([
      this.prisma.communityPost.count({ where }),
      this.prisma.communityPost.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: this.skip(query),
        take: query.pageSize,
        select: communityPostSelect,
      }),
    ]);
    return this.page(
      records.map((record) => ({
        ...this.normalizeCommunityPost(record, true),
        targetType: ModerationTargetType.CommunityPost,
      })),
      total,
      query,
    );
  }

  private async listCommunityComments(
    query: ListModerationQuery,
  ): Promise<PaginatedModerationResponse> {
    const where: Prisma.CommunityCommentWhereInput = {
      deletedAt: null,
      ...(query.status ? { moderationStatus: query.status } : {}),
      ...(query.search
        ? { content: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };
    const [total, records] = await this.prisma.$transaction([
      this.prisma.communityComment.count({ where }),
      this.prisma.communityComment.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: this.skip(query),
        take: query.pageSize,
        select: communityCommentSelect,
      }),
    ]);
    return this.page(
      records.map((record) => ({
        ...this.normalizeCommunityComment(record, true),
        targetType: ModerationTargetType.CommunityComment,
      })),
      total,
      query,
    );
  }

  private async findTarget(
    client: ModerationClient,
    targetType: ModerationTargetTypeValue,
    targetId: string,
  ): Promise<NormalizedModerationRecord> {
    switch (targetType) {
      case ModerationTargetType.Course: {
        const record = await client.course.findFirst({
          where: { id: targetId, deletedAt: null },
          select: courseSelect,
        });
        if (!record) throw new NotFoundException('Moderation target not found');
        return this.normalizeCourse(record, false);
      }
      case ModerationTargetType.LibraryResource: {
        const record = await client.libraryResource.findFirst({
          where: { id: targetId, deletedAt: null },
          select: libraryResourceSelect,
        });
        if (!record) throw new NotFoundException('Moderation target not found');
        return this.normalizeLibraryResource(record, false);
      }
      case ModerationTargetType.CommunityPost: {
        const record = await client.communityPost.findFirst({
          where: { id: targetId, deletedAt: null },
          select: communityPostSelect,
        });
        if (!record) throw new NotFoundException('Moderation target not found');
        return this.normalizeCommunityPost(record, false);
      }
      case ModerationTargetType.CommunityComment: {
        const record = await client.communityComment.findFirst({
          where: { id: targetId, deletedAt: null },
          select: communityCommentSelect,
        });
        if (!record) throw new NotFoundException('Moderation target not found');
        return this.normalizeCommunityComment(record, false);
      }
    }
  }

  private async updateTarget(
    client: ModerationClient,
    targetType: ModerationTargetTypeValue,
    targetId: string,
    data: {
      moderationStatus: ModerationStatus;
      moderationReason: string;
      moderatedAt: Date;
    },
  ): Promise<NormalizedModerationRecord> {
    switch (targetType) {
      case ModerationTargetType.Course:
        return this.normalizeCourse(
          await client.course.update({
            where: { id: targetId },
            data,
            select: courseSelect,
          }),
          false,
        );
      case ModerationTargetType.LibraryResource:
        return this.normalizeLibraryResource(
          await client.libraryResource.update({
            where: { id: targetId },
            data,
            select: libraryResourceSelect,
          }),
          false,
        );
      case ModerationTargetType.CommunityPost:
        return this.normalizeCommunityPost(
          await client.communityPost.update({
            where: { id: targetId },
            data,
            select: communityPostSelect,
          }),
          false,
        );
      case ModerationTargetType.CommunityComment:
        return this.normalizeCommunityComment(
          await client.communityComment.update({
            where: { id: targetId },
            data,
            select: communityCommentSelect,
          }),
          false,
        );
    }
  }

  private findStatus(
    targetType: ModerationTargetTypeValue,
    targetId: string,
    ownerWhere: Record<string, string>,
  ) {
    const args = {
      where: { id: targetId, deletedAt: null, ...ownerWhere },
      select: moderationStatusSelect,
    };
    switch (targetType) {
      case ModerationTargetType.Course:
        return this.prisma.course.findFirst(args);
      case ModerationTargetType.LibraryResource:
        return this.prisma.libraryResource.findFirst(args);
      case ModerationTargetType.CommunityPost:
        return this.prisma.communityPost.findFirst(args);
      case ModerationTargetType.CommunityComment:
        return this.prisma.communityComment.findFirst(args);
    }
  }

  private ownerWhere(
    targetType: ModerationTargetTypeValue,
    ownerId: string,
  ): Record<string, string> {
    switch (targetType) {
      case ModerationTargetType.Course:
        return { instructorId: ownerId };
      case ModerationTargetType.LibraryResource:
        return { ownerId };
      case ModerationTargetType.CommunityPost:
      case ModerationTargetType.CommunityComment:
        return { authorId: ownerId };
    }
  }

  private normalizeCourse(
    record: Prisma.CourseGetPayload<{ select: typeof courseSelect }>,
    truncate: boolean,
  ): NormalizedModerationRecord {
    return {
      ...this.common(record),
      title: record.title,
      content: this.content(record.description, truncate),
      owner: record.instructor,
    };
  }

  private normalizeLibraryResource(
    record: Prisma.LibraryResourceGetPayload<{
      select: typeof libraryResourceSelect;
    }>,
    truncate: boolean,
  ): NormalizedModerationRecord {
    return {
      ...this.common(record),
      title: record.title,
      content: this.content(record.description, truncate),
      owner: record.owner,
    };
  }

  private normalizeCommunityPost(
    record: Prisma.CommunityPostGetPayload<{
      select: typeof communityPostSelect;
    }>,
    truncate: boolean,
  ): NormalizedModerationRecord {
    return {
      ...this.common(record),
      title: record.title,
      content: this.content(record.content, truncate),
      owner: record.author,
    };
  }

  private normalizeCommunityComment(
    record: Prisma.CommunityCommentGetPayload<{
      select: typeof communityCommentSelect;
    }>,
    truncate: boolean,
  ): NormalizedModerationRecord {
    return {
      ...this.common(record),
      title: `Comment on ${record.post.title}`,
      content: this.content(record.content, truncate),
      owner: record.author,
    };
  }

  private common(record: {
    id: string;
    moderationStatus: ModerationStatus;
    moderationReason: string | null;
    moderatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: record.id,
      moderationStatus: record.moderationStatus,
      moderationReason: record.moderationReason,
      moderatedAt: record.moderatedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private content(value: string | null, truncate: boolean): string | null {
    if (!value || !truncate || value.length <= 240) return value;
    return `${value.slice(0, 237)}...`;
  }

  private skip(query: ListModerationQuery): number {
    return (query.page - 1) * query.pageSize;
  }

  private page(
    items: ModerationItemResponse[],
    total: number,
    query: ListModerationQuery,
  ): PaginatedModerationResponse {
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
