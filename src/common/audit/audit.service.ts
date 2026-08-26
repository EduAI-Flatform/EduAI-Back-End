import { Injectable } from '@nestjs/common';
import { AuditActorKind, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditActionValue } from './audit.constants';

export { AuditAction } from './audit.constants';

export interface AuditWriteInput {
  actorKind?: AuditActorKind;
  actorId?: string;
  action: AuditActionValue;
  target: {
    type: string;
    id: string;
  };
  metadata?: Record<string, unknown>;
}

type AuditWriterClient = Pick<Prisma.TransactionClient, 'auditLog'>;

const auditLogSelect = {
  id: true,
  actorKind: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  metadataJson: true,
  occurredAt: true,
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
    },
  },
} satisfies Prisma.AuditLogSelect;

export type AuditLogResponse = Prisma.AuditLogGetPayload<{
  select: typeof auditLogSelect;
}>;

export interface PaginatedAuditLogResponse {
  items: AuditLogResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListAuditLogsQuery {
  page: number;
  pageSize: number;
  search?: string;
  action?: string;
  targetType?: string;
  occurredAfter?: string;
  occurredBefore?: string;
}

const SENSITIVE_KEY_PATTERN =
  /(password|token|secret|cookie|authorization|credential|sessionid|apikey)/i;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    input: AuditWriteInput,
    client: AuditWriterClient = this.prisma,
  ): Promise<void> {
    const actorKind = input.actorKind ?? AuditActorKind.USER;
    if (
      (actorKind === AuditActorKind.USER && !input.actorId) ||
      (actorKind !== AuditActorKind.USER && input.actorId)
    ) {
      throw new Error('Audit actor kind and identity do not match.');
    }
    await client.auditLog.create({
      data: {
        actorKind,
        actorId: input.actorId,
        action: input.action,
        targetType: input.target.type,
        targetId: input.target.id,
        metadataJson: this.sanitizeObject(input.metadata ?? {}),
      },
      select: { id: true },
    });
  }

  async list(query: ListAuditLogsQuery): Promise<PaginatedAuditLogResponse> {
    const where = this.buildWhere(query);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: auditLogSelect,
      }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  listTargetHistory(
    targetType: string,
    targetId: string,
    take = 50,
  ): Promise<AuditLogResponse[]> {
    return this.prisma.auditLog.findMany({
      where: {
        action: AuditAction.ContentModerationChanged,
        targetType,
        targetId,
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(take, 1), 100),
      select: auditLogSelect,
    });
  }

  private buildWhere(query: ListAuditLogsQuery): Prisma.AuditLogWhereInput {
    return {
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.occurredAfter || query.occurredBefore
        ? {
            occurredAt: {
              ...(query.occurredAfter
                ? { gte: new Date(query.occurredAfter) }
                : {}),
              ...(query.occurredBefore
                ? { lte: new Date(query.occurredBefore) }
                : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { action: { contains: query.search, mode: 'insensitive' } },
              { targetType: { contains: query.search, mode: 'insensitive' } },
              { targetId: { contains: query.search, mode: 'insensitive' } },
              {
                actor: {
                  is: {
                    OR: [
                      { email: { contains: query.search, mode: 'insensitive' } },
                      {
                        fullName: {
                          contains: query.search,
                          mode: 'insensitive',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
  }

  private sanitizeObject(input: Record<string, unknown>): Prisma.InputJsonObject {
    return Object.fromEntries(
      Object.entries(input).flatMap(([key, value]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) return [];
        const sanitized = this.sanitizeValue(value);
        return sanitized === undefined ? [] : [[key, sanitized]];
      }),
    );
  }

  private sanitizeValue(value: unknown): Prisma.InputJsonValue | undefined {
    if (typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (value === null) return undefined;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const sanitized = this.sanitizeValue(item);
        return sanitized === undefined ? [] : [sanitized];
      });
    }
    if (typeof value === 'object') {
      return this.sanitizeObject(value as Record<string, unknown>);
    }
    return undefined;
  }
}
