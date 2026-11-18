import { loadAffiliateSummary } from './affiliate-summary';

const at = new Date('2030-03-01T00:00:00Z');
function source() {
  const postings = [
    { amount: 120n, createdAt: new Date('2030-02-28T23:59:59Z') },
    { amount: -30n, createdAt: new Date('2030-03-01T00:00:00Z') },
  ];
  return {
    affiliateAccrual: { aggregate: jest.fn(async ({ where }: any) => ({ _sum: { deltaMinor: postings
      .filter(row => row.createdAt < where.createdAt.lt && (!where.createdAt.gte || row.createdAt >= where.createdAt.gte))
      .reduce((sum, row) => sum + row.amount, 0n) } })) },
    affiliateAttribution: { findMany: jest.fn().mockResolvedValue([]) },
    commerceRefund: { findMany: jest.fn().mockResolvedValue([]) },
  };
}
function attributed() {
  return { id: 'attribution', identityId: 'identity', policyRevisionId: 'policy', createdAt: new Date('2030-02-01'),
    visit: { identityId: 'identity', policyRevisionId: 'policy', createdAt: new Date('2030-01-31') },
    order: { id: 'order', status: 'confirmed', fulfillmentStatus: 'fulfilled', currency: 'VND', payableAmountMinor: 1000n,
      confirmedSettlementId: 'settlement', confirmedSettlement: { id: 'settlement', orderId: 'order', amountMinor: 1000n,
        currency: 'VND', settledAt: new Date('2030-02-02'), kind: 'provider_collection', disposition: 'matched' } } };
}

it('uses signed postings, exclusive UTC boundaries and owner-scoped read queries', async () => {
  const db = source();
  const result = await loadAffiliateSummary(db as any, 'owner', at);
  expect(result.lifetimeCommissionMinor).toBe('120');
  expect(result.today).toEqual({ startsAt: at.toISOString(), endsBefore: at.toISOString(), amountMinor: '0' });
  expect(result.month.amountMinor).toBe('0');
  expect(result.revenue.amountMinor).toBe('0');
  expect(result.ranking.value).toBeNull(); expect(result.subAffiliates.count).toBeNull();
  for (const [query] of db.affiliateAccrual.aggregate.mock.calls) expect(query.where.attribution.identity.ownerId).toBe('owner');
  expect(db.affiliateAttribution.findMany.mock.calls[0][0].where).toMatchObject({ identity: { ownerId: 'owner' }, createdAt: { lt: at } });
});

it('counts canonical net paid revenue once rather than summing commission bases', async () => {
  const db = source(), row = attributed();
  db.affiliateAttribution.findMany.mockResolvedValue([row]);
  db.commerceRefund.findMany.mockResolvedValue([{ id: 'refund', orderId: 'order', settlementId: 'settlement', status: 'recorded', currency: 'VND', amountMinor: 250n, recordedAt: new Date('2030-02-10') }]);
  const result = await loadAffiliateSummary(db as any, 'owner', at);
  expect(result.revenue).toMatchObject({ status: 'available', complete: true, amountMinor: '750' });
  expect(db.commerceRefund.findMany.mock.calls[0][0].where.orderId.in).toEqual(['order']);
});

it('includes a signed correction in the current UTC day and month', async () => {
  const result = await loadAffiliateSummary(source() as any, 'owner', new Date('2030-03-01T12:00:00Z'));
  expect(result.lifetimeCommissionMinor).toBe('90');
  expect(result.today.amountMinor).toBe('-30'); expect(result.month.amountMinor).toBe('-30');
});

it('does not count a settlement at the exclusive snapshot boundary', async () => {
  const db = source(), row = attributed(); row.order.confirmedSettlement.settledAt = at;
  db.affiliateAttribution.findMany.mockResolvedValue([row]);
  expect((await loadAffiliateSummary(db as any, 'owner', at)).revenue.amountMinor).toBe('0');
  expect(db.commerceRefund.findMany).not.toHaveBeenCalled();
});

it.each(['currency', 'chronology', 'settlement', 'refund_date'])('does not report partial revenue with invalid %s evidence', async kind => {
  const db = source(), row = attributed();
  if (kind === 'currency') row.order.currency = 'USD';
  if (kind === 'chronology') row.visit.createdAt = new Date('2031-01-01');
  if (kind === 'settlement') row.order.confirmedSettlement.amountMinor = 999n;
  db.affiliateAttribution.findMany.mockResolvedValue([row]);
  if (kind === 'refund_date') db.commerceRefund.findMany.mockResolvedValue([{ id: 'bad', orderId: 'order', settlementId: 'settlement', status: 'recorded', currency: 'VND', amountMinor: 1n, recordedAt: null }]);
  const result = await loadAffiliateSummary(db as any, 'owner', at);
  expect(result.revenue.status).toBe('unavailable'); expect(result.revenue.amountMinor).toBeNull();
  expect(result.lifetimeCommissionMinor).toBe('120');
});

it.each(['orders', 'refunds'])('refuses an incomplete total at the %s resource bound', async kind => {
  const db = source();
  db.affiliateAttribution.findMany.mockImplementation(async ({ take }: any) => kind === 'orders' ? Array(take).fill(attributed()) : [attributed()]);
  db.commerceRefund.findMany.mockImplementation(async ({ take }: any) => Array(take).fill({}));
  const result = await loadAffiliateSummary(db as any, 'owner', at);
  expect(result.revenue).toMatchObject({ status: 'unavailable', amountMinor: null, complete: false });
});
