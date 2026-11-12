import { computeActivityPointImpact } from './activity-point-impact';

const at = new Date('2026-11-12T12:00:00Z');
const before = { enabled: true, expireAfterMonths: 12, maxDaily: 100, rules: [{ event: 'course.completed', points: 80 }] };
const event = (userId: string, id: string) => ({ id, userId, completedAt: new Date('2026-11-01T10:00:00Z') });
const client = (events: ReturnType<typeof event>[]) => ({ enrollment: { findMany: jest.fn().mockResolvedValue(events) } });
describe('Admin point policy impact simulation', () => {
  it('replays canonical activity with shared UTC caps without writing awards or altering history', async () => {
    const tx = client([event('a', '1'), event('a', '2'), event('b', '3')]);
    const after = { ...before, maxDaily: 120 };
    const result = await computeActivityPointImpact(tx as never, before, after, at);
    expect(result).toMatchObject({ status: 'evaluated', simulationOnly: true, sampledEvents: 3,
      sampledLearners: 2, affectedLearners: 1, changedEvents: 1, beforePoints: 180, afterPoints: 200,
      historicalAwardsPreserved: true, reprocessesHistoricalEvents: false });
    expect(tx.enrollment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5001,
      where: expect.objectContaining({ status: 'completed', completedAt: { gte: new Date('2026-10-13T12:00:00Z'), lte: at } }) }));
  });
  it('shows changed validity even when award amounts stay the same', async () => {
    const result = await computeActivityPointImpact(client([event('a', '1')]) as never, before, { ...before, expireAfterMonths: 6 }, at);
    expect(result).toMatchObject({ affectedLearners: 1, changedEvents: 1, beforePoints: 80, afterPoints: 80 });
  });
  it('reports disabled accrual with zero proposed points, without removing historic rights', async () => {
    const result = await computeActivityPointImpact(client([event('a', '1')]) as never, before, { ...before, enabled: false }, at);
    expect(result).toMatchObject({ afterPoints: 0, historicalAwardsPreserved: true, affectedLearners: 1 });
  });
  it('refuses to present a truncated sample as a complete impact estimate', async () => {
    const events = Array.from({ length: 5001 }, (_, i) => event('a', String(i)));
    expect(await computeActivityPointImpact(client(events) as never, before, before, at))
      .toMatchObject({ status: 'limit_exceeded', sampleLimit: 5000, beforePoints: null, afterPoints: null, affectedLearners: null });
  });
});
