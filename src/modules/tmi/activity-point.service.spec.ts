import { ActivityPointService } from './activity-point.service';

const completedAt = new Date('2026-11-01T15:00:00Z');
function harness() {
  const source = { id: 'enrollment-1', userId: 'user-1', status: 'completed', completedAt };
  const policy = { id: 'policy-1', content: { enabled: true, maxDaily: 100, expireAfterMonths: 12,
    rules: [{ event: 'course.completed', points: 80 }] } };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: source.userId }]),
    enrollment: { findUnique: jest.fn().mockResolvedValue(source) },
    platformPolicyRevision: { findFirst: jest.fn().mockResolvedValue(policy) },
    pointActivityReceipt: { findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 70 } }),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'receipt-1', ...data })) },
    tmiLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
  };
  const prisma = { $transaction: jest.fn().mockImplementation(async operation => operation(tx)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ActivityPointService(prisma as never, audit as never);
  return { tx, prisma, audit, service, source, policy };
}

describe('canonical course completion point adapter', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-11-12T10:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });
  it('reads the source from the server, locks its owner and freezes the effective policy', async () => {
    const { tx, service, audit } = harness();
    await expect(service.recordCourseCompletion('enrollment-1')).resolves.toMatchObject({ amount: 30, policyRevisionId: 'policy-1' });
    expect(tx.platformPolicyRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { group: 'points', status: 'scheduled', effectiveAt: { lte: completedAt } },
      orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
    }));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      userId: 'user-1', amount: 30, sourceType: 'platform_activity', sourceId: 'enrollment-1',
      expiresAt: new Date('2027-11-01T15:00:00Z'),
    }) }));
    expect(tx.pointActivityReceipt.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: 'user-1', occurredAt: { gte: new Date('2026-11-01T00:00:00Z'), lt: new Date('2026-11-02T00:00:00Z') },
    } }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ policyRevisionId: 'policy-1' }) }), tx);
  });
  it('returns the immutable receipt on replay without awarding or consulting a new policy', async () => {
    const { tx, service } = harness();
    tx.pointActivityReceipt.findUnique.mockResolvedValue({ id: 'existing', amount: 80 } as never);
    await expect(service.recordCourseCompletion('enrollment-1')).resolves.toMatchObject({ id: 'existing' });
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.platformPolicyRevision.findFirst).not.toHaveBeenCalled();
  });
  it('does not award for an uncompleted source or when no policy was effective', async () => {
    const { source, tx, service } = harness();
    source.status = 'active';
    await expect(service.recordCourseCompletion('enrollment-1')).resolves.toBeNull();
    source.status = 'completed';
    tx.platformPolicyRevision.findFirst.mockResolvedValue(null);
    await expect(service.recordCourseCompletion('enrollment-1')).resolves.toBeNull();
    expect(tx.pointActivityReceipt.create).not.toHaveBeenCalled();
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
  });
  it('records a disabled-policy outcome without a zero-value ledger entry', async () => {
    const { policy, tx, service } = harness();
    policy.content.enabled = false;
    await expect(service.recordCourseCompletion('enrollment-1')).resolves.toMatchObject({ outcome: 'disabled', amount: 0, ledgerEntryId: null });
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
  });
  it('refuses an owner change between source discovery and locking', async () => {
    const { tx, service, source } = harness();
    tx.enrollment.findUnique.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, userId: 'other' });
    await expect(service.recordCourseCompletion('enrollment-1')).rejects.toThrow('POINT_ACTIVITY_SOURCE_CHANGED');
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
  });
});
