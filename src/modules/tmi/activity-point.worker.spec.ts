import { ActivityPointWorker } from './activity-point.worker';

function harness() {
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'user' }]) };
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'user' }]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([{ id: 'completion', completedAt: new Date('2026-11-01') }]) },
    platformPolicyRevision: { findFirst: jest.fn().mockResolvedValue({ effectiveAt: new Date('2026-10-01') }) },
    $transaction: jest.fn().mockImplementation(async operation => operation(tx)),
  };
  const awards = { recordCourseCompletion: jest.fn().mockResolvedValue({ id: 'receipt' }) };
  const ledger = { settle: jest.fn().mockResolvedValue([]) };
  const worker = new ActivityPointWorker(prisma as never, awards as never, ledger as never);
  return { worker, prisma, tx, awards, ledger };
}

describe('bounded activity point worker', () => {
  it('processes expiry independently when no award policy is configured', async () => {
    const { worker, prisma, tx, ledger, awards } = harness();
    prisma.platformPolicyRevision.findFirst.mockResolvedValue(null);
    await worker.runBatch();
    expect(ledger.settle).toHaveBeenCalledWith(tx, 'user', 'user', expect.any(Date), 25);
    expect(awards.recordCourseCompletion).not.toHaveBeenCalled();
    expect(prisma.enrollment.findMany).not.toHaveBeenCalled();
  });
  it('bounds both queues and reads only canonical unprocessed completions', async () => {
    const { worker, prisma, awards } = harness();
    await worker.runBatch();
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(prisma.enrollment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50,
      where: expect.objectContaining({ status: 'completed', pointActivityReceipts: { none: { eventType: 'course.completed' } } }) }));
    expect(awards.recordCourseCompletion).toHaveBeenCalledWith('completion');
  });
  it('continues the completion queue after a single source fails', async () => {
    const { worker, prisma, awards } = harness();
    prisma.enrollment.findMany.mockResolvedValue([{ id: 'failed', completedAt: new Date('2026-11-01') },
      { id: 'valid', completedAt: new Date('2026-11-02') }]);
    awards.recordCourseCompletion.mockRejectedValueOnce(new Error('invalid source'));
    await worker.runBatch();
    expect(awards.recordCourseCompletion.mock.calls.map(args => args[0])).toEqual(['failed', 'valid']);
  });
  it('continues accrual discovery when the expiry scan fails', async () => {
    const { worker, prisma, awards } = harness();
    prisma.user.findMany.mockRejectedValueOnce(new Error('retry expiry'));
    await worker.runBatch();
    expect(awards.recordCourseCompletion).toHaveBeenCalledWith('completion');
  });
  it('prevents overlapping batches in the same process', async () => {
    const { worker, prisma } = harness();
    let release!: () => void;
    prisma.user.findMany.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const first = worker.runBatch();
    await worker.runBatch();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    release(); await first;
  });
});
