import { loadCardServiceImpact } from './card-service-impact';
import { DEFAULT_CARD_SERVICE_LIMITS } from './membership-card-limits.policy';
import type { MembershipCardPolicy } from './membership-card.evaluator';
const definitionId = '00000000-0000-4000-8000-000000000001';
const at = new Date('2026-11-10');
const policy = (quota: string): MembershipCardPolicy => ({ enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS, enabled: true }, tiers: [{ code: 'custom', name: { vi: 'Riêng', en: 'Custom' },
    threshold: 0, benefits: [], serviceLimits: [{ definitionId, quota }] }] });
const definition = { id: definitionId, code: 'AI_CHAT', valueType: 'metered', unitLabel: 'request', resetPeriod: 'calendar_month' };
function client() {
  return { serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([definition]) },
    serviceEntitlementUsage: { findMany: jest.fn().mockResolvedValue([
      { userId: 'owner', quantity: 2n, createdAt: new Date('2026-11-02'), grant: { definitionId } },
      { userId: 'owner', quantity: 1n, createdAt: new Date('2026-10-02'), grant: { definitionId } },
    ]) } };
}
describe('consumed card quota impact', () => {
  it('projects a reduction using prior card consumption without resetting the counter or reading purchased usage', async () => {
    const db = client(); const before = policy('5'), after = policy('1');
    const impact = await loadCardServiceImpact(db as never, [before, after], ['owner'], at);
    expect(impact.complete).toBe(true);
    expect(impact.project('owner', before, before.tiers[0])).toMatchObject([{ quota: '5', consumed: '2', remaining: '3', overLimit: false }]);
    expect(impact.project('owner', after, after.tiers[0])).toMatchObject([{ quota: '1', consumed: '2', remaining: '0', overLimit: true }]);
    expect(db.serviceEntitlementUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: { in: ['owner'] }, grant: { sourceType: 'MEMBERSHIP_CARD', definitionId: { in: [definitionId] } },
    } }));
  });
  it('retains lifetime usage across new policy start dates', async () => {
    const db = client(); db.serviceEntitlementDefinition.findMany.mockResolvedValue([{ ...definition, resetPeriod: 'none' }]);
    const value = policy('5'); const impact = await loadCardServiceImpact(db as never, [value], ['owner'], at);
    expect(impact.project('owner', value, value.tiers[0])).toMatchObject([{ consumed: '3', remaining: '2', periodStartsAt: null, periodEndsAt: null }]);
  });
  it('does not invent remaining values for unbound definitions or source-scan overflow', async () => {
    const db = client(); const value = policy('5');
    db.serviceEntitlementDefinition.findMany.mockResolvedValueOnce([]);
    const missing = await loadCardServiceImpact(db as never, [value], ['owner'], at);
    expect(missing.complete).toBe(false);
    expect(missing.project('owner', value, value.tiers[0])).toBeNull();
    db.serviceEntitlementUsage.findMany.mockResolvedValueOnce(new Array(10001).fill({}));
    const overflow = await loadCardServiceImpact(db as never, [value], ['owner'], at);
    expect(overflow).toMatchObject({ complete: false, issues: [{ reason: 'CARD_SERVICE_USAGE_SCAN_LIMIT_EXCEEDED' }] });
    expect(overflow.project('owner', value, value.tiers[0])).toBeNull();
  });
  it('keeps disabled policy projections empty and avoids reading usage without configured rules', async () => {
    const db = client(); const value = { ...policy('5'), enabled: false };
    const impact = await loadCardServiceImpact(db as never, [value], ['owner'], at);
    expect(impact.configured).toBe(false);
    expect(impact.project('owner', value, value.tiers[0])).toEqual([]);
    expect(db.serviceEntitlementUsage.findMany).not.toHaveBeenCalled();
  });
});
