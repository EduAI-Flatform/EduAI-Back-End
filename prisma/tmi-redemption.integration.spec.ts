import 'dotenv/config';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TmiRedemptionService } from '../src/modules/tmi/tmi-redemption.service';
import { CourseAccessService } from '../src/modules/access/course-access.service';
import { TmiRewardKind, TmiRewardStatus } from '../generated/prisma/client';

const integration = process.env.TMI_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('TMI redemption PostgreSQL transaction contract', () => {
  const prisma = new PrismaService();
  const service = new TmiRedemptionService(
    prisma,
    new AuditService(prisma),
    new CourseAccessService(prisma),
  );
  const suffix = `integration-${Date.now()}`;
  let studentId: string;
  let adminId: string;
  const rewardIds: string[] = [];
  const ledgerSourceIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    const student = await prisma.user.findFirst({ where: { email: 'student.demo@eduai.local' }, select: { id: true } });
    const admin = await prisma.user.findFirst({ where: { email: 'admin.demo@eduai.local' }, select: { id: true } });
    if (!student || !admin) throw new Error('Demo users are required for TMI integration verification');
    studentId = student.id;
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.tmiEntitlement.deleteMany({ where: { redemption: { rewardId: { in: rewardIds } } } });
    await prisma.tmiLedgerEntry.deleteMany({ where: { OR: ledgerSourceIds.map((sourceId) => ({ sourceType: 'tmi_integration', sourceId })) } });
    await prisma.tmiLedgerEntry.deleteMany({ where: { redemption: { rewardId: { in: rewardIds } } } });
    await prisma.tmiRedemption.deleteMany({ where: { rewardId: { in: rewardIds } } });
    await prisma.tmiReward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.$disconnect();
  });

  it('commits one redemption, makes replay idempotent, and refunds exactly once', async () => {
    const reward = await prisma.tmiReward.create({
      data: {
        title: `Integration reward ${suffix}`,
        kind: TmiRewardKind.gift,
        cost: 10,
        status: TmiRewardStatus.active,
        quota: 2,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
        createdById: adminId,
      },
    });
    rewardIds.push(reward.id);
    const earnSource = `${suffix}-earn`;
    ledgerSourceIds.push(earnSource);
    await prisma.tmiLedgerEntry.create({
      data: { userId: studentId, kind: 'earn', amount: 100, sourceType: 'tmi_integration', sourceId: earnSource, actorId: adminId },
    });

    const first = await service.redeem(studentId, reward.id, { idempotencyKey: `${suffix}-request` });
    const replay = await service.redeem(studentId, reward.id, { idempotencyKey: `${suffix}-request` });
    const counts = await Promise.all([
      prisma.tmiRedemption.count({ where: { id: first.id } }),
      prisma.tmiLedgerEntry.count({ where: { redemptionId: first.id, kind: 'redeem' } }),
      prisma.tmiEntitlement.count({ where: { redemptionId: first.id, status: 'active' } }),
    ]);

    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(counts).toEqual([1, 1, 1]);

    const refund = await service.refund(adminId, first.id, { reason: 'integration rollback' });
    const refundReplay = await service.refund(adminId, first.id, { reason: 'integration rollback' });
    expect(refund.idempotent).toBe(false);
    expect(refundReplay.idempotent).toBe(true);
    expect(await prisma.tmiLedgerEntry.count({ where: { redemptionId: first.id, kind: 'refund' } })).toBe(1);
    expect(await prisma.tmiEntitlement.count({ where: { redemptionId: first.id, status: 'revoked' } })).toBe(1);
  });

  it('allows only one concurrent redemption when quota is one', async () => {
    const reward = await prisma.tmiReward.create({
      data: {
        title: `Concurrent reward ${suffix}`,
        kind: TmiRewardKind.gift,
        cost: 10,
        status: TmiRewardStatus.active,
        quota: 1,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
        createdById: adminId,
      },
    });
    rewardIds.push(reward.id);
    const outcomes = await Promise.allSettled([
      service.redeem(studentId, reward.id, { idempotencyKey: `${suffix}-concurrent-a` }),
      service.redeem(studentId, reward.id, { idempotencyKey: `${suffix}-concurrent-b` }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await prisma.tmiRedemption.count({ where: { rewardId: reward.id } })).toBe(1);
    expect(await prisma.tmiLedgerEntry.count({ where: { redemption: { rewardId: reward.id }, kind: 'redeem' } })).toBe(1);
  });
});
