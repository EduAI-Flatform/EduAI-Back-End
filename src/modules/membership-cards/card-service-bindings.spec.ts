import { inspectCardServiceBindings, isBoundCardRequestDefinition } from './card-service-bindings';
import { DEFAULT_CARD_SERVICE_LIMITS } from './membership-card-limits.policy';

const id = '00000000-0000-4000-8000-000000000001';
const definition = { id, code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month', unitLabel: 'request' };
const policy = { enabled: true, basis: 'spend' as const, currency: 'VND', cycleMode: 'rolling' as const, cycleMonths: 12,
  serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS, enabled: true },
  tiers: [{ code: 'custom', name: { vi: 'Riêng', en: 'Custom' }, threshold: 0, benefits: [], serviceLimits: [{ definitionId: id, quota: '5' }] }] };
describe('administrator card service binding inspection', () => {
  it('accepts stable metered request bindings and reads each referenced definition once across tiers', async () => {
    const client = { serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([definition]) } };
    const result = await inspectCardServiceBindings(client as never, { ...policy, tiers: [policy.tiers[0], { ...policy.tiers[0], code: 'another' }] });
    expect(result).toEqual({ ready: true, issues: [] });
    expect(client.serviceEntitlementDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [id] } } }));
  });
  it.each([
    [[], 'CARD_SERVICE_DEFINITION_NOT_FOUND'],
    [[{ ...definition, code: 'UNBOUND' }], 'CARD_SERVICE_OPERATION_NOT_BOUND'],
    [[{ ...definition, valueType: 'boolean' }], 'CARD_SERVICE_REQUIRES_REQUEST_QUOTA'],
    [[{ ...definition, unitLabel: 'token' }], 'CARD_SERVICE_REQUIRES_REQUEST_QUOTA'],
    [[{ ...definition, resetPeriod: 'membership_term' }], 'CARD_SERVICE_TERM_NOT_CONFIGURED'],
  ])('reports configuration problems without inventing a service or quota %#', async (definitions, reason) => {
    const client = { serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue(definitions) } };
    expect(await inspectCardServiceBindings(client as never, policy)).toEqual({ ready: false, issues: [{ definitionId: id, reason }] });
  });
  it('does not query references when no service rules are present', async () => {
    const client = { serviceEntitlementDefinition: { findMany: jest.fn() } };
    expect(await inspectCardServiceBindings(client as never, { ...policy, tiers: [{ ...policy.tiers[0], serviceLimits: [] }] }))
      .toEqual({ ready: true, issues: [] });
    expect(client.serviceEntitlementDefinition.findMany).not.toHaveBeenCalled();
  });
  it('uses the same executable definition check for runtime binding', () => {
    expect(isBoundCardRequestDefinition(definition)).toBe(true);
    expect(isBoundCardRequestDefinition({ ...definition, code: 'UNBOUND' })).toBe(false);
  });
});
