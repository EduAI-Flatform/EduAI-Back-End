import { computeMembershipCardForUser, computeMembershipCardImpact } from './membership-card-source';
import type { MembershipCardPolicy } from './membership-card.evaluator';
const policy: MembershipCardPolicy = { enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  tiers: [{ code: 'member', name: { vi: 'Member', en: 'Member' }, threshold: 0, benefits: [] }] };
function client() {
  return { commerceOrder: { findMany: jest.fn().mockResolvedValue([]) }, user: {
    count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]),
  } };
}
describe('membership impact source', () => {
  it('reads only the authenticated user purchases', async () => {
    const db = client();
    await computeMembershipCardForUser(db as any, policy, 'v1', 'owner');
    expect(db.commerceOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { buyerId: 'owner', status: 'confirmed', fulfillmentStatus: 'fulfilled' },
    }));
  });
  it('shows complete=false for a paginated impact rather than claiming global totals', async () => {
    const db = client();
    const result = await computeMembershipCardImpact(db as any, policy, 'v1', { pageSize: 1 });
    expect(result).toMatchObject({ totalUsers: 2, evaluatedUsers: 1, complete: false, nextCursor: 'one', activationReady: false });
  });
  it('does not read order data for unapproved top-up sources', async () => {
    const db = client();
    const result = await computeMembershipCardImpact(db as any, { ...policy, basis: 'topup' }, 'v1');
    expect(result).toMatchObject({ status: 'unavailable', reason: 'TOPUP_SOURCE_NOT_APPROVED', complete: false });
    expect(db.commerceOrder.findMany).not.toHaveBeenCalled();
  });
  it('does not silently truncate source orders', async () => {
    const db = client();
    db.commerceOrder.findMany.mockResolvedValue(Array.from({ length: 10001 }, () => ({})) as never);
    const result = await computeMembershipCardForUser(db as any, policy, 'v1', 'owner');
    expect(result).toMatchObject({ status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', qualifyingAmountMinor: null });
  });
});
