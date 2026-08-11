import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ModerationStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import {
  ModerationAction,
  ModerationService,
  ModerationTargetType,
} from './moderation.service';

const targetId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const createdAt = new Date('2026-08-01T00:00:00.000Z');
const updatedAt = new Date('2026-08-02T00:00:00.000Z');

const courseRecord = {
  id: targetId,
  title: 'Safe course title',
  description: 'Course description',
  moderationStatus: ModerationStatus.clear,
  moderationReason: null,
  moderatedAt: null,
  createdAt,
  updatedAt,
  instructor: {
    id: ownerId,
    fullName: 'Course owner',
  },
};

describe('ModerationService', () => {
  it('lists a bounded target-specific moderation queue', async () => {
    const prisma = {
      course: {
        count: jest.fn().mockReturnValue('count-query'),
        findMany: jest.fn().mockReturnValue('items-query'),
      },
      $transaction: jest.fn().mockResolvedValue([1, [courseRecord]]),
    };
    const service = new ModerationService(prisma as never, {} as never);

    await expect(
      service.list({
        targetType: ModerationTargetType.Course,
        status: ModerationStatus.clear,
        search: 'safe',
        page: 2,
        pageSize: 10,
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: targetId,
          targetType: ModerationTargetType.Course,
          title: courseRecord.title,
          owner: courseRecord.instructor,
          moderationStatus: ModerationStatus.clear,
        }),
      ],
      page: 2,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });

    const where = {
      deletedAt: null,
      moderationStatus: ModerationStatus.clear,
      OR: [
        { title: { contains: 'safe', mode: 'insensitive' } },
        { description: { contains: 'safe', mode: 'insensitive' } },
      ],
    };
    expect(prisma.course.count).toHaveBeenCalledWith({ where });
    expect(prisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 10,
        take: 10,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('returns review detail with exact append-only target history', async () => {
    const history = [{ id: 'audit-id', action: 'CONTENT_MODERATION_CHANGED' }];
    const prisma = {
      course: { findFirst: jest.fn().mockResolvedValue(courseRecord) },
    };
    const auditService = {
      listTargetHistory: jest.fn().mockResolvedValue(history),
    };
    const service = new ModerationService(
      prisma as never,
      auditService as never,
    );

    await expect(
      service.getDetail(ModerationTargetType.Course, targetId),
    ).resolves.toEqual({
      item: expect.objectContaining({ id: targetId, title: courseRecord.title }),
      history,
    });
    expect(auditService.listTargetHistory).toHaveBeenCalledWith(
      ModerationTargetType.Course,
      targetId,
      50,
    );
  });

  it('changes state and records the reason atomically', async () => {
    const moderatedAt = new Date('2026-08-03T00:00:00.000Z');
    const updatedRecord = {
      ...courseRecord,
      moderationStatus: ModerationStatus.rejected,
      moderationReason: 'Violates publishing standards',
      moderatedAt,
      updatedAt: moderatedAt,
    };
    const tx = {
      course: {
        findFirst: jest.fn().mockResolvedValue(courseRecord),
        update: jest.fn().mockResolvedValue(updatedRecord),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        (operation: (client: typeof tx) => unknown) => operation(tx),
      ),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ModerationService(
      prisma as never,
      auditService as never,
    );

    await expect(
      service.moderate(actorId, ModerationTargetType.Course, targetId, {
        action: ModerationAction.Reject,
        reason: 'Violates publishing standards',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        moderationStatus: ModerationStatus.rejected,
        moderationReason: 'Violates publishing standards',
      }),
    );
    expect(tx.course.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: {
        moderationStatus: ModerationStatus.rejected,
        moderationReason: 'Violates publishing standards',
        moderatedAt: expect.any(Date),
      },
      select: expect.any(Object),
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId,
        action: AuditAction.ContentModerationChanged,
        target: { type: ModerationTargetType.Course, id: targetId },
        metadata: {
          action: ModerationAction.Reject,
          previousStatus: ModerationStatus.clear,
          newStatus: ModerationStatus.rejected,
          reason: 'Violates publishing standards',
        },
      },
      tx,
    );
  });

  it('rejects unsupported transitions before writing', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new ModerationService(prisma as never, {} as never);

    await expect(
      service.moderate(actorId, ModerationTargetType.Course, targetId, {
        action: ModerationAction.Hide,
        reason: 'Needs temporary review',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns owner-visible status without exposing another owner target', async () => {
    const prisma = {
      course: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: targetId,
            moderationStatus: ModerationStatus.hidden,
            moderationReason: 'Under review',
            moderatedAt: updatedAt,
          })
          .mockResolvedValueOnce(null),
      },
    };
    const service = new ModerationService(prisma as never, {} as never);

    await expect(
      service.getOwnerStatus(
        { id: ownerId, roles: [RoleName.instructor] },
        ModerationTargetType.Course,
        targetId,
      ),
    ).resolves.toEqual({
      id: targetId,
      targetType: ModerationTargetType.Course,
      moderationStatus: ModerationStatus.hidden,
      moderationReason: 'Under review',
      moderatedAt: updatedAt,
    });
    expect(prisma.course.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: targetId, deletedAt: null, instructorId: ownerId },
      select: expect.any(Object),
    });

    await expect(
      service.getOwnerStatus(
        { id: 'other-user', roles: [RoleName.instructor] },
        ModerationTargetType.Course,
        targetId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
