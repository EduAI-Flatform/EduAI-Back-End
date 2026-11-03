import { RevenueFinanceService } from './revenue-finance.service';
import { PrismaService } from '../../prisma/prisma.service';

function harness(kind: 'course' | 'membership' = 'course') {
  const entries: { periodId: string; sourceKey: string; kind: string; amountMinor: bigint; sourceRefundId?: string }[] = [];
  const periods: { id: string; snapshotId: string; courseId: string; sellerId: string; periodIndex: number; dueAt: Date; amountMinor: bigint }[] = [];
  const refunds: { id: string; amountMinor: bigint; settlementId: string }[] = [];
  const snapshot = { id: 'line', orderId: 'order', productType: kind, basisAmountMinor: 100000n, platformAmountMinor: 20000n, sellerAmountMinor: 80000n, participants: [{ courseId: 'course', sellerId: 'seller', weight: 1, amountMinor: '80000' }] };
  const order = { id: 'order', buyerId: 'buyer', status: 'confirmed', payableAmountMinor: 100000n, currency: 'VND', confirmedSettlementId: 'settlement', createdAt: new Date('2028-01-31T00:00:00Z'), confirmedAt: new Date('2028-01-31T00:00:00Z'),
    membershipCheckoutIntent: { durationOption: { months: 2 } },
    confirmedSettlement: { id: 'settlement', orderId: 'order', amountMinor: 100000n, currency: 'VND', kind: 'provider_collection', disposition: 'matched', provider: 'payos', providerSettlementReference: 'ref', paymentAttemptId: 'attempt', paymentEventId: 'event', settledAt: new Date('2028-01-31T00:00:00Z'),
      paymentAttempt: { id: 'attempt', orderId: 'order', provider: 'payos', providerPaymentIdentity: 'payment', providerOrderCode: 123n, status: 'paid', amountMinor: 100000n, currency: 'VND' },
      paymentEvent: { id: 'event', provider: 'payos', paymentAttemptId: 'attempt', providerPaymentIdentity: 'payment', providerSettlementReference: 'ref', amountMinor: 100000n, currency: 'VND', nextStatus: 'paid', providerOccurredAt: new Date('2028-01-31T00:00:00Z') },
    },
  };
  let subscription: { startsAt: Date; expiresAt: Date } | null = { startsAt: new Date('2028-01-31T00:00:00Z'), expiresAt: new Date('2028-03-31T00:00:00Z') };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    revenueRetailPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    revenueOrderSnapshot: { findMany: jest.fn().mockResolvedValue([{id:'line'}]), findUniqueOrThrow: jest.fn(async () => ({ ...snapshot, periods })) },
    commerceOrder: { findUnique: jest.fn(async () => order) },
    membershipSubscription: { findUnique: jest.fn(async () => subscription) },
    revenueEarningPeriod: {
      create: jest.fn(async ({data}) => { const period = { ...data, id: `p${periods.length}` }; periods.push(period); return period; }),
      findMany: jest.fn(async ({where}) => periods.filter(p => !where.dueAt || p.dueAt <= where.dueAt.lte).map(p => ({...p,entries:entries.filter(e => e.periodId === p.id)}))),
    },
    revenueLedgerEntry: { create: jest.fn(async ({data}) => { if(entries.some(e => e.sourceKey===data.sourceKey)) throw new Error('Duplicate journal'); entries.push(data); return data; }) },
    commerceRefundAllocation: { findMany: jest.fn(async ({where}) => refunds.filter(r => r.settlementId === where.refund.settlementId).map(r => ({ ...r, refundId: r.id }))) },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  const service = new RevenueFinanceService(prisma as unknown as PrismaService);
  return { service, tx, snapshot, order, periods, entries, refunds, setSubscription: (value: typeof subscription) => { subscription=value; } };
}

describe('recoverable revenue recognition', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2028-04-01T00:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });
  it('records retail revenue once across repeated batches', async () => {
    const h = harness();
    await h.service.runBatch(new Date('2028-02-01Z'));
    await h.service.runBatch(new Date('2028-02-01Z'));
    expect(h.periods).toHaveLength(1);
    expect(h.entries).toEqual([{ periodId: 'p0', sourceKey: 'recognize:p0', kind: 'recognized', amountMinor: 80000n }]);
  });
  it('never earns from temporary receipt access or pending payment', async () => {
    const h = harness(); h.order.status = 'pending_payment';
    await h.service.runBatch();
    expect(h.periods).toEqual([]); expect(h.entries).toEqual([]);
  });
  it('rejects mismatched provider proof even when order says confirmed', async () => {
    const h = harness(); h.order.confirmedSettlement.paymentEvent.providerPaymentIdentity = 'other';
    await h.service.runBatch();
    expect(h.entries).toEqual([]); expect(h.periods).toEqual([]);
  });
  it('waits for membership fulfillment and uses actual subscription dates', async () => {
    const h = harness('membership'); h.setSubscription(null);
    await h.service.runBatch(); expect(h.periods).toEqual([]);
    h.setSubscription({ startsAt: new Date('2028-04-30Z'), expiresAt: new Date('2028-06-30Z') });
    await h.service.runBatch(new Date('2028-05-01Z'));
    expect(h.periods.map(p => p.dueAt.toISOString())).toEqual(['2028-05-30T00:00:00.000Z','2028-06-30T00:00:00.000Z']);
    expect(h.entries).toEqual([]);
  });
  it('recognizes at month end, handling leap years and catch-up without duplicates', async () => {
    const h = harness('membership');
    await h.service.runBatch(new Date('2028-02-28T23:59:59Z')); expect(h.entries).toEqual([]);
    await h.service.runBatch(new Date('2028-02-29Z')); expect(h.entries.map(e => e.amountMinor)).toEqual([40000n]);
    await h.service.runBatch(new Date('2028-04-01Z')); expect(h.entries.map(e => e.amountMinor)).toEqual([40000n,40000n]);
  });
  it('reduces both pending and recognized obligations for a partial refund', async () => {
    const h = harness('membership');
    await h.service.runBatch(new Date('2028-02-29Z'));
    h.refunds.push({id:'r1',amountMinor:50000n,settlementId:'settlement'});
    await h.service.runBatch(new Date('2028-03-01Z'));
    expect(h.entries.filter(e => e.kind==='refund_recognized').map(e => e.amountMinor)).toEqual([-20000n]);
    expect(h.entries.filter(e => e.kind==='refund_pending').map(e => e.amountMinor)).toEqual([-20000n]);
    await h.service.runBatch(new Date('2028-04-01Z'));
    expect(h.entries.filter(e => e.kind==='recognized').map(e => e.amountMinor)).toEqual([40000n,20000n]);
    expect(h.entries.filter(e => e.kind!=='refund_pending').reduce((s,e) => s+e.amountMinor,0n)).toBe(40000n);
  });
  it('reverses full refunds without double-counting prior partial refunds', async () => {
    const h = harness(); await h.service.runBatch();
    h.refunds.push({id:'r1',amountMinor:30000n,settlementId:'settlement'});
    await h.service.runBatch();
    h.refunds.push({id:'r2',amountMinor:70000n,settlementId:'settlement'});
    await h.service.runBatch(); await h.service.runBatch();
    expect(h.entries.reduce((s,e) => s+e.amountMinor,0n)).toBe(0n);
    expect(h.entries).toHaveLength(3);
    expect(h.entries.filter(e => e.kind.startsWith('refund_')).map(e => e.sourceRefundId)).toEqual(['r1','r2']);
  });
  it('does not reverse order earnings for a duplicate collection refund', async () => {
    const h = harness(); await h.service.runBatch();
    h.refunds.push({id:'r1',amountMinor:100000n,settlementId:'duplicate-settlement'});
    await h.service.runBatch(); expect(h.entries).toHaveLength(1);
  });
  it('fully refunded future subscriptions never recognize positive earnings', async () => {
    const h = harness('membership'); h.refunds.push({id:'r1',amountMinor:100000n,settlementId:'settlement'});
    await h.service.runBatch(new Date('2028-02-01Z'));
    await h.service.runBatch(new Date('2028-04-01Z'));
    expect(h.entries.filter(e => e.kind==='recognized').map(e => e.amountMinor)).toEqual([0n,0n]);
  });
  it('combines multiple course shares for one seller without losing allocation', async () => {
    const h = harness('membership');
    h.snapshot.participants = [{courseId:'a',sellerId:'seller',weight:1,amountMinor:'30000'},{courseId:'b',sellerId:'seller',weight:2,amountMinor:'50000'}];
    await h.service.runBatch(new Date('2028-04-01Z'));
    expect(h.periods).toHaveLength(4);
    expect(h.entries.reduce((s,e) => s+e.amountMinor,0n)).toBe(80000n);
  });
});