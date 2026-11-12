import { BadRequestException, ConflictException } from '@nestjs/common';
import { TmiRewardKind, TmiRewardStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { TmiRedemptionService } from './tmi-redemption.service';
import { PointLedgerService } from './point-ledger.service';

const now = new Date();
const redemptionWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const redemptionWindowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const userId = '00000010-0000-4000-8000-000000000005';
const rewardId = '00000020-0000-4000-8000-000000000001';
const courseId = '00000030-0000-4000-8000-000000000001';

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
        startsAt: redemptionWindowStart,
        endsAt: redemptionWindowEnd,
        inventoryMetadata: { courseId },
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
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ kind: 'earn', amount: 100, adjustmentDirection: null }]),
      create: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    },
    tmiEntitlement: {
      create: jest.fn().mockResolvedValue({ id: 'entitlement-1', status: 'active' }),
      findUnique: jest.fn().mockResolvedValue({ kind: TmiRewardKind.course_access, benefitMetadata: { courseId } }),
      update: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const audit = { record: jest.fn() };
  const courseAccess = { ensureGrant: jest.fn(), revokeGrant: jest.fn() };
  return { service: new TmiRedemptionService(prisma as never, audit as never, courseAccess as never, new PointLedgerService(audit as never)), tx, prisma, audit, courseAccess };
}

describe('TmiRedemptionService', () => {
  it('uses the same valuation time for balance authorization and its debit at an expiry boundary', async () => {
    const at = new Date(now);
    jest.useFakeTimers().setSystemTime(at);
    try {
      const { service, tx } = createHarness();
      tx.tmiLedgerEntry.findMany.mockResolvedValue([{ id: 'native', userId, kind: 'earn', amount: 100,
        adjustmentDirection: null, sourceType: 'platform_activity', sourceId: 'completion',
        occurredAt: new Date(at.getTime() - 10000), expiresAt: new Date(at.getTime() + 1000), postingSequence: 1n }]);
      tx.tmiRedemption.create.mockImplementation(async () => {
        jest.setSystemTime(new Date(at.getTime() + 2000));
        return { id: 'redemption-1', userId, rewardId, idempotencyKey: 'boundary', cost: 40, createdAt: at };
      });
      await service.redeem(userId, rewardId, { idempotencyKey: 'boundary' });
      expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        kind: 'redeem', occurredAt: at,
      }) }));
    } finally { jest.useRealTimers(); }
  });
  it('refuses to spend due activity points before the expiry worker runs', async () => {
    const { service, tx } = createHarness();
    const due = new Date(Date.now() - 10000);
    const native = { id: 'native', userId, kind: 'earn', amount: 100, adjustmentDirection: null,
      sourceType: 'platform_activity', sourceId: 'completion', occurredAt: new Date(due.getTime() - 10000), expiresAt: due, postingSequence: 1n };
    tx.tmiLedgerEntry.findMany.mockResolvedValue([native]);
    (tx as any).pointExpirySettlement = { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'expiry' }) };
    tx.tmiLedgerEntry.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'expiry', postingSequence: 2n }));
    await expect(service.redeem(userId, rewardId, { idempotencyKey: 'expired' })).rejects.toThrow('Insufficient TMI balance');
    expect(tx.tmiRedemption.create).not.toHaveBeenCalled();
  });
  it.each([[20, 100, 100], [80, 0, 0]])('refunds native/legacy spending (%i/%i) with original expiry and idempotent replay', async (nativeCredit, legacyCredit, expectedBalance) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T10:00:00Z'));
    try {
      const { service, tx } = createHarness();
      const expiresAt = new Date('2026-11-10T00:00:00Z');
      const base = { userId, adjustmentDirection: null, occurredAt: new Date('2026-11-01T00:00:00Z'), metadata: null };
      const entries: any[] = [
        { ...base, id: 'native', kind: 'earn', amount: nativeCredit, sourceType: 'platform_activity', sourceId: 'completion', expiresAt, postingSequence: 1n },
        { ...base, id: 'legacy', kind: 'earn', amount: legacyCredit, sourceType: 'legacy', sourceId: 'legacy', expiresAt: null, postingSequence: 2n },
        { ...base, id: 'spent', kind: 'redeem', amount: 40, sourceType: 'tmi_redemption', sourceId: 'redemption-1',
          redemptionId: 'redemption-1', expiresAt: null, occurredAt: new Date('2026-11-09T00:00:00Z'), postingSequence: 3n },
      ].filter(row => row.amount > 0);
      tx.tmiLedgerEntry.findMany.mockImplementation(async () => [...entries]);
      tx.tmiLedgerEntry.create.mockImplementation(async ({ data }: any) => {
        const row = { ...data, id: `posting-${entries.length}`, postingSequence: BigInt(entries.length + 10), adjustmentDirection: null, expiresAt: data.expiresAt ?? null };
        entries.push(row); return row;
      });
      (tx as any).pointExpirySettlement = { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'expiry-receipt' }) };
      tx.tmiRedemption.findUnique.mockResolvedValue({ id: 'redemption-1', userId, rewardId, cost: 40, createdAt: base.occurredAt, idempotencyKey: 'old' } as never);
      await service.refund(userId, 'redemption-1', {});
      expect(entries.filter(row => row.kind === 'refund' && row.sourceType === 'platform_activity_refund')).toEqual([
        expect.objectContaining({ amount: Math.min(nativeCredit, 40), expiresAt }),
      ]);
      expect(entries.filter(row => row.kind === 'refund' && row.sourceType === 'tmi_redemption')
        .reduce((sum, row) => sum + row.amount, 0)).toBe(40 - Math.min(nativeCredit, 40));
      expect(entries.filter(row => row.kind === 'expiry').reduce((sum, row) => sum + row.amount, 0)).toBe(nativeCredit);
      const wallet = await service.wallet(userId);
      expect(wallet.current).toBe(expectedBalance);
      const count = entries.length;
      tx.tmiLedgerEntry.findFirst.mockResolvedValue({ id: 'already-refunded' } as never);
      await expect(service.refund(userId, 'redemption-1', {})).resolves.toMatchObject({ idempotent: true });
      expect(entries).toHaveLength(count);
    } finally { jest.useRealTimers(); }
  });
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
    const { service, tx, audit, courseAccess } = createHarness();

    const result = await service.redeem(userId, rewardId, { idempotencyKey: 'request-001' });

    expect(result).toMatchObject({ id: 'redemption-1', idempotent: false, cost: 40 });
    expect(tx.tmiRedemption.create).toHaveBeenCalled();
    expect(tx.tmiEntitlement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ redemptionId: 'redemption-1', userId }),
    }));
    expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'redeem', amount: 40, userId }),
    }));
    expect(courseAccess.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      courseId,
      sourceType: 'tmi_reward',
      sourceId: 'redemption-1',
    }), tx);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.TmiRewardRedeemed }), tx);
  });

  it('revokes only the refunded TMI reward grant in the same transaction', async () => {
    const { service, tx, courseAccess } = createHarness();
    tx.tmiRedemption.findUnique.mockResolvedValueOnce({
      id: 'redemption-1', userId, rewardId, idempotencyKey: 'request-001', cost: 40, createdAt: now,
    });

    await expect(service.refund('admin-id', 'redemption-1', {
      reason: 'Support correction',
    })).resolves.toMatchObject({ idempotent: false });

    expect(courseAccess.revokeGrant).toHaveBeenCalledWith({
      userId,
      courseId,
      sourceType: 'tmi_reward',
      sourceId: 'redemption-1',
    }, 'Support correction', tx);
    expect(tx.tmiEntitlement.update).toHaveBeenCalled();
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

  it('uses the server reward cost even when an untrusted client adds a cost field', async () => {
    const { service, tx } = createHarness();

    await service.redeem(userId, rewardId, { idempotencyKey: 'request-003', cost: 1 } as never);

    expect(tx.tmiRedemption.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ cost: 40 }),
    }));
    expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 40 }),
    }));
  });

  it('rejects an administrative debit that would make the server-derived balance negative', async () => {
    const { service, tx } = createHarness();
    tx.tmiLedgerEntry.findMany.mockResolvedValue([{ kind: 'earn', amount: 5, adjustmentDirection: null }]);

    await expect(service.adjustBalance('admin-1', {
      userId,
      amount: 10,
      direction: 'debit',
      adjustmentKey: 'negative-check-001',
      reason: 'Invariant test',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
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
