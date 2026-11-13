import { provisionCardServiceGrant, resolveCardServiceQuota } from './membership-card-service-quota';

const at = new Date('2026-11-10T12:00:00Z');
const definitionId = '00000000-0000-4000-8000-000000000001';
const revisionId = '00000000-0000-4000-8000-000000000002';
const definition = { id: definitionId, code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month',
  displayName: 'AI chat', description: null, unitLabel: 'request', displayOrder: 0 };
const policy = () => ({ enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  serviceLimits: { enabled: true, consumptionPriority: 'card_first', termAnchorAt: '', termMonths: 0 },
  tiers: [{ code: 'custom', name: { vi: 'Hạng riêng', en: 'Custom tier' }, threshold: 0, benefits: [],
    serviceLimits: [{ definitionId, quota: '5' }] }] });
function harness() {
  const content = policy();
  const client = { platformPolicyRevision: { findFirst: jest.fn().mockResolvedValue({ id: revisionId, content, effectiveAt: new Date('2026-11-01') }) },
    commerceOrder: { findMany: jest.fn().mockResolvedValue([]) },
    gdsInternalTopup: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([definition]) },
    serviceEntitlementGrant: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() } };
  return { client, content };
}
describe('current card service quota candidates', () => {
  it('resolves an Admin-defined tier from the current policy without writing a grant', async () => {
    const { client } = harness();
    const resolved = await resolveCardServiceQuota(client as never, 'owner', 'AI_CHAT', at);
    expect(resolved.priority).toBe('card_first');
    expect(resolved.grants).toHaveLength(1);
    expect(resolved.grants[0]).toMatchObject({ userId: 'owner', sourceType: 'MEMBERSHIP_CARD', cardPolicyRevisionId: revisionId,
      cardTierCode: 'custom', quota: 5n, startsAt: new Date('2026-11-01'), endsAt: new Date('2026-12-01'),
      cardQualification: { qualifyingAmountMinor: '0', basis: 'spend', currency: 'VND' } });
    expect(client.platformPolicyRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { group: 'membership', status: 'scheduled', effectiveAt: { lte: at } },
      orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
    }));
    expect(client.serviceEntitlementGrant.createMany).not.toHaveBeenCalled();
    const repeated = await resolveCardServiceQuota(client as never, 'owner', 'AI_CHAT', new Date('2026-11-11'));
    expect(repeated.grants[0].sourceId).toBe(resolved.grants[0].sourceId);
  });
  it('does not fall back to an older policy or invent quota when disabled, unversioned or unqualified', async () => {
    const { client, content } = harness();
    content.enabled = false;
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants).toEqual([]);
    expect(client.commerceOrder.findMany).not.toHaveBeenCalled();
    client.platformPolicyRevision.findFirst.mockResolvedValueOnce(null);
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants).toEqual([]);
    content.enabled = true; content.basis = 'topup';
    client.gdsInternalTopup.findMany.mockResolvedValueOnce(new Array(10001).fill({}));
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants).toEqual([]);
  });
  it.each([
    { ...definition, code: 'UNBOUND_SERVICE' }, { ...definition, valueType: 'boolean' },
    { ...definition, unitLabel: 'token' },
  ])('excludes a definition that cannot bind to the real request operation %#', async invalid => {
    const { client } = harness(); client.serviceEntitlementDefinition.findMany.mockResolvedValueOnce([invalid]);
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants).toEqual([]);
  });
  it('reuses provenance for an existing period and does not resurrect a revoked grant', async () => {
    const { client } = harness(); const first = await resolveCardServiceQuota(client as never, 'owner', undefined, at);
    const existing = { ...first.grants[0], id: 'persisted' };
    client.serviceEntitlementGrant.findMany.mockResolvedValueOnce([existing]);
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants[0].id).toBe('persisted');
    client.serviceEntitlementGrant.findMany.mockResolvedValueOnce([{ ...existing, status: 'revoked' }]);
    expect((await resolveCardServiceQuota(client as never, 'owner', undefined, at)).grants).toEqual([]);
  });
  it('materializes a candidate idempotently only when requested by the consumption transaction', async () => {
    const { client } = harness(); const { grants } = await resolveCardServiceQuota(client as never, 'owner', undefined, at);
    const persisted = { ...grants[0], id: 'stored' };
    const findFirstOrThrow = jest.fn().mockResolvedValue(persisted);
    Object.assign(client.serviceEntitlementGrant, { findFirstOrThrow });
    expect(await provisionCardServiceGrant(client as never, grants[0])).toBe(persisted);
    expect(client.serviceEntitlementGrant.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      userId: 'owner', sourceType: 'MEMBERSHIP_CARD', cardPolicyRevisionId: revisionId, cardTierCode: 'custom', createdAt: at,
    })], skipDuplicates: true });
    expect(client.serviceEntitlementGrant.createMany.mock.calls[0][0].data[0]).not.toHaveProperty('definition');
    expect(client.serviceEntitlementGrant.createMany.mock.calls[0][0].data[0]).not.toHaveProperty('id');
  });
});
