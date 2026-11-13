import { computeMembershipCardForUser, computeMembershipCardImpact } from './membership-card-source';
import type { MembershipCardPolicy } from './membership-card.evaluator';
import { DEFAULT_CARD_SERVICE_LIMITS } from './membership-card-limits.policy';
const policy: MembershipCardPolicy = { enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  tiers: [{ code: 'member', name: { vi: 'Member', en: 'Member' }, threshold: 0, benefits: [] }] };
function client() {
  return { serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementUsage: { findMany: jest.fn().mockResolvedValue([]) },
    commerceOrder: { findMany: jest.fn().mockResolvedValue([]) }, gdsInternalTopup: { findMany: jest.fn().mockResolvedValue([]) }, user: {
    count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]),
  } };
}
describe('membership impact source', () => {
  it('includes consumed quota in the per-user before/after projection while preserving independent purchases', async () => {
    const db = client(); const definitionId = '00000000-0000-4000-8000-000000000001';
    db.serviceEntitlementDefinition.findMany.mockResolvedValue([{ id: definitionId, code: 'AI_CHAT',
      valueType: 'metered', unitLabel: 'request', resetPeriod: 'calendar_month' }]);
    db.serviceEntitlementUsage.findMany.mockResolvedValue([{ userId: 'one', quantity: 2n, createdAt: new Date('2026-11-02'), grant: { definitionId } }]);
    const before = { ...policy, serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS, enabled: true },
      tiers: [{ ...policy.tiers[0], serviceLimits: [{ definitionId, quota: '5' }] }] };
    const after = { ...before, tiers: [{ ...before.tiers[0], serviceLimits: [{ definitionId, quota: '1' }] }] };
    const result = await computeMembershipCardImpact(db as any, after, 'new', { beforePolicy: before, beforeRevisionId: 'old', at: new Date('2026-11-10') });
    expect(result).toMatchObject({ serviceConsumptionProjected: true, serviceLimitImpactScope: 'consumption_included',
      projectedServiceRemainingChangesOnPage: 2, preservesPurchasedAccess: true, items: [
        { userId: 'one', previousServiceQuota: [{ consumed: '2', remaining: '3' }], projectedServiceQuota: [{ consumed: '2', remaining: '0', overLimit: true }] },
        { userId: 'two', projectedServiceQuota: [{ consumed: '0', remaining: '1' }] },
      ] });
    expect(db.serviceEntitlementUsage.findMany).toHaveBeenCalledTimes(1);
  });
  it('reports executable limit configuration separately and does not claim consumption projection', async () => {
    const after = { ...policy, serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS, enabled: true },
      tiers: [{ ...policy.tiers[0], serviceLimits: [{ definitionId: 'definition', quota: '25' }] }] };
    const result = await computeMembershipCardImpact(client() as any, after, 'new', { beforePolicy: policy, beforeRevisionId: 'old' });
    expect(result).toMatchObject({ projectedBenefitChangesOnPage: 0, projectedServiceLimitChangesOnPage: 2,
      serviceLimitImpactScope: 'configuration_only', serviceConsumptionProjected: false });
    const disabled = await computeMembershipCardImpact(client() as any,
      { ...after, serviceLimits: { ...after.serviceLimits, enabled: false } }, 'new', { beforePolicy: policy, beforeRevisionId: 'old' });
    expect(disabled).toMatchObject({ projectedServiceLimitChangesOnPage: 0 });
  });
  it('does not claim a complete projection when usage exceeds the bounded source scan', async () => {
    const db = client(); const definitionId = '00000000-0000-4000-8000-000000000001';
    db.serviceEntitlementDefinition.findMany.mockResolvedValue([{ id: definitionId, code: 'AI_CHAT', valueType: 'metered', unitLabel: 'request', resetPeriod: 'none' }]);
    db.serviceEntitlementUsage.findMany.mockResolvedValue(new Array(10001).fill({}));
    const after = { ...policy, serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS, enabled: true },
      tiers: [{ ...policy.tiers[0], serviceLimits: [{ definitionId, quota: '5' }] }] };
    expect(await computeMembershipCardImpact(db as any, after, 'new', { beforePolicy: policy, beforeRevisionId: 'old' }))
      .toMatchObject({ status: 'unavailable', complete: false, serviceConsumptionProjected: false,
        reason: 'CARD_SERVICE_USAGE_SCAN_LIMIT_EXCEEDED', items: [{ projectedServiceQuota: null }, { projectedServiceQuota: null }] });
  });
  it('does not count reordered localized JSON object keys as changed benefits', async () => {
    const db = client();
    const before = { ...policy, tiers: [{ ...policy.tiers[0], benefits: [{ vi: 'A', en: 'B' }] }] };
    const after = { ...policy, tiers: [{ ...policy.tiers[0], benefits: [{ en: 'B', vi: 'A' }] }] };
    const result = await computeMembershipCardImpact(db as any, after, 'new', { beforePolicy: before, beforeRevisionId: 'old' });
    expect(result).toMatchObject({ projectedChangesOnPage: 0, projectedBenefitChangesOnPage: 0 });
    expect(result.items.every(item => item.projectedBenefitsChanged === false)).toBe(true);
  });
  it('still reports actual localized content and benefit-list order changes', async () => {
    const before = { ...policy, tiers: [{ ...policy.tiers[0], benefits: [{ vi: 'A', en: 'B' }, { vi: 'C', en: 'D' }] }] };
    for (const benefits of [[{ vi: 'A', en: 'Edited' }, { vi: 'C', en: 'D' }], [...before.tiers[0].benefits].reverse()]) {
      const result = await computeMembershipCardImpact(client() as any,
        { ...policy, tiers: [{ ...policy.tiers[0], benefits }] }, 'new', { beforePolicy: before, beforeRevisionId: 'old' });
      expect(result).toMatchObject({ projectedChangesOnPage: 0, projectedBenefitChangesOnPage: 2 });
      expect(result.items.every(item => item.projectedBenefitsChanged === true)).toBe(true);
    }
  });
  it('reports benefit changes even when the tier code is unchanged', async () => {
    const db = client();
    const updated = { ...policy, tiers: [{ ...policy.tiers[0], benefits: [{ vi: 'Ưu đãi mới', en: 'New benefit' }] }] };
    const result = await computeMembershipCardImpact(db as any, updated, 'new', { beforePolicy: policy, beforeRevisionId: 'old' });
    expect(result).toMatchObject({ projectedChangesOnPage: 0, projectedBenefitChangesOnPage: 2 });
    expect(result.items[0]).toMatchObject({ projectedBenefitsChanged: true, previousBenefits: [] });
  });
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
  it('loads only credited top-ups for top-up classification without counting purchases', async () => {
    const db = client();
    const result = await computeMembershipCardImpact(db as any, { ...policy, basis: 'topup' }, 'v1');
    expect(result).toMatchObject({ status: 'evaluated', complete: true });
    expect(db.commerceOrder.findMany).not.toHaveBeenCalled();
    expect(db.gdsInternalTopup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { buyerId: { in: ['one', 'two'] }, status: 'CREDITED' },
    }));
    const own = client();
    await computeMembershipCardForUser(own as any, { ...policy, basis: 'topup' }, 'v1', 'owner');
    expect(own.gdsInternalTopup.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerId: 'owner', status: 'CREDITED' } }));
    expect(own.commerceOrder.findMany).not.toHaveBeenCalled();
  });
  it.each(['spend', 'topup'] as const)('loads both sources to compare a change from %s to the other basis', async basis => {
    const db = client();
    await computeMembershipCardImpact(db as any, { ...policy, basis: basis === 'spend' ? 'topup' : 'spend' }, 'new',
      { beforePolicy: { ...policy, basis }, beforeRevisionId: 'old' });
    expect(db.commerceOrder.findMany).toHaveBeenCalledTimes(1);
    expect(db.gdsInternalTopup.findMany).toHaveBeenCalledTimes(1);
  });
  it('fails closed instead of silently truncating top-up evidence', async () => {
    const db = client();
    db.gdsInternalTopup.findMany.mockResolvedValue(Array.from({ length: 10001 }, () => ({})) as never);
    expect(await computeMembershipCardForUser(db as any, { ...policy, basis: 'topup' }, 'v', 'owner'))
      .toMatchObject({ status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', tier: null });
    expect(await computeMembershipCardImpact(db as any, { ...policy, basis: 'topup' }, 'v'))
      .toMatchObject({ status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', complete: false });
  });
  it('does not silently truncate source orders', async () => {
    const db = client();
    db.commerceOrder.findMany.mockResolvedValue(Array.from({ length: 10001 }, () => ({})) as never);
    const result = await computeMembershipCardForUser(db as any, policy, 'v1', 'owner');
    expect(result).toMatchObject({ status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', qualifyingAmountMinor: null });
  });
});
