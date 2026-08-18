import { BadRequestException, ConflictException } from '@nestjs/common';
import { TmiRewardKind, TmiRewardStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { TmiRedemptionService } from './tmi-redemption.service';

const now = new Date('2026-08-18T14:00:00.000Z');
const userId = '00000010-0000-4000-8000-000000000005';
const rewardId = '00000020-0000-4000-8000-000000000001';

function createHarness() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: userId }]),
    user: { findUnique: jest.fn().mockResolvedValue({ id: userId }) },
    tmiReward: {
      findUnique: jest.fn().mockResolvedValue({
        id: rewardId,
        title: 'Course reward',
        kind: TmiRewardKind.course_access,
        cost: 40,
        status: TmiRewardStatus.active,
        quota: 10,
        redeemedCount: 1,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-09-01T00:00:00.000Z'),
        inventoryMetadata: { courseId: 'course-1' },
      }),
      update: jest.fn().mockResolvedValue({ redeemedCount: 2 }),
    },
    tmiRedemption: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'redemption-1', userId, rewardId, idempotencyKey: 'request-001', cost: 40,
        createdAt: now,
      }),
    },
    tmiLedgerEntry: {
      findMany: jest.fn().mockResolvedValue([{ kind: 'earn', amount: 100, adjustmentDirection: null }]),
      create: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    },
    tmiEntitlement: {
      create: jest.fn().mockResolvedValue({ id: 'entitlement-1', status: 'active' }),
      update: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const audit = { record: jest.fn() };
  return { service: new TmiRedemptionService(prisma as never, audit as never), tx, prisma, audit };
}

describe('TmiRedemptionService', () => {
  it('returns paginated sanitized redemption history for administrators', async () => {
    const { service, prisma } = createHarness();
    (prisma as any).tmiRedemption = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: 'redemption-1', userId, rewardId, cost: 40, createdAt: now, reward: { title: 'Course reward', kind: TmiRewardKind.course_access } }]),
    };

    await expect(service.listAdminRedemptions({ page: 1, pageSize: 20 })).resolves.toEqual({
      items: [{ id: 'redemption-1', userId, rewardId, cost: 40, createdAt: now, reward: { title: 'Course reward', kind: TmiRewardKind.course_access } }],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
    expect((prisma as any).tmiRedemption.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('returns paginated sanitized ledger history without metadata or actor secrets', async () => {
    const { service, prisma } = createHarness();
    (prisma as any).tmiLedgerEntry = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: 'ledger-1', userId, kind: 'earn', amount: 100, adjustmentDirection: null, sourceType: 'course_completion', occurredAt: now }]),
    };

    await expect(service.listAdminLedger({ page: 1, pageSize: 20 })).resolves.toEqual({
      items: [{ id: 'ledger-1', userId, kind: 'earn', amount: 100, adjustmentDirection: null, sourceType: 'course_completion', occurredAt: now }],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
    expect((prisma as any).tmiLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('creates one entitlement and debit ledger entry atomically', async () => {
    const { service, tx, audit } = createHarness();

    const result = await service.redeem(userId, rewardId, { idempotencyKey: 'request-001' });

    expect(result).toMatchObject({ id: 'redemption-1', idempotent: false, cost: 40 });
    expect(tx.tmiRedemption.create).toHaveBeenCalled();
    expect(tx.tmiEntitlement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ redemptionId: 'redemption-1', userId }),
    }));
    expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'redeem', amount: 40, userId }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.TmiRewardRedeemed }), tx);
  });

  it('returns the existing redemption for the same idempotency key', async () => {
    const { service, tx } = createHarness();
    tx.tmiRedemption.findUnique.mockResolvedValue({ id: 'redemption-1', rewardId, userId, idempotencyKey: 'request-001', cost: 40, createdAt: now });

    await expect(service.redeem(userId, rewardId, { idempotencyKey: 'request-001' })).resolves.toMatchObject({ idempotent: true });
    expect(tx.tmiRedemption.create).not.toHaveBeenCalled();
  });

  it('rejects the same idempotency key when it belongs to another reward', async () => {
    const { service, tx } = createHarness();
    tx.tmiRedemption.findUnique.mockResolvedValue({ id: 'redemption-1', rewardId: 'other-reward', userId, idempotencyKey: 'request-001', cost: 40, createdAt: now });

    await expect(service.redeem(userId, rewardId, { idempotencyKey: 'request-001' })).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ['insufficient balance', [{ kind: 'earn', amount: 20, adjustmentDirection: null }]],
    ['disabled reward', [{ kind: 'earn', amount: 100, adjustmentDirection: null }]],
  ])('rejects %s safely', async (label, entries) => {
    const { service, tx } = createHarness();
    tx.tmiLedgerEntry.findMany.mockResolvedValue(entries);
    if (label === 'disabled reward') tx.tmiReward.findUnique.mockResolvedValue({ ...await tx.tmiReward.findUnique(), status: TmiRewardStatus.disabled });

    await expect(service.redeem(userId, rewardId, { idempotencyKey: 'request-002' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.tmiRedemption.create).not.toHaveBeenCalled();
  });
});
