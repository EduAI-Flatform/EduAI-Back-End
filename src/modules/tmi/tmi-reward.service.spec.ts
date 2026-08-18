import { TmiRewardKind, TmiRewardStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { TmiRewardService } from './tmi-reward.service';

const reward = { id: 'reward-id', title: 'Course Access', description: null, kind: TmiRewardKind.course_access, cost: 100, status: TmiRewardStatus.draft, quota: 10, redeemedCount: 0, startsAt: new Date('2026-08-01'), endsAt: new Date('2026-09-01'), inventoryMetadata: null, createdById: 'admin-id', createdAt: new Date('2026-08-01'), updatedAt: new Date('2026-08-01') };

describe('TmiRewardService', () => {
  it('creates a draft reward through an auditable admin transaction', async () => {
    const tx = { tmiReward: { create: jest.fn().mockResolvedValue(reward) } };
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new TmiRewardService(prisma as never, audit as never);
    await expect(service.create('admin-id', { title: 'Course Access', kind: TmiRewardKind.course_access, cost: 100, startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', quota: 10 })).resolves.toMatchObject({ id: 'reward-id', cost: 100, status: TmiRewardStatus.draft });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.TmiRewardCreated }), tx);
  });
});
