import { reconcileLegacyMembership, type LegacyMembershipFacts } from './legacy-membership-reconciliation';

const start = new Date('2025-01-01T00:00:00Z');
const end = new Date('2025-02-01T00:00:00Z');
function facts(): LegacyMembershipFacts {
  return {
    orderId: 'order', buyerId: 'buyer', lineId: 'line', versionId: 'version', sourceVerified: true,
    startsAt: start, endsAt: end,
    subscription: { id: 'subscription', userId: 'buyer', versionId: 'version', sourceOrderLineId: 'line', startsAt: start, expiresAt: end, status: 'active' },
    courses: [{ courseId: 'course', sourceType: 'membership', sourceId: 'line', startsAt: start, endsAt: end }],
    services: [{ definitionId: 'definition', valueType: 'metered', resetPeriod: 'membership_term', booleanValue: null, quota: 10n }],
    courseGrants: [{ id: 'course-grant', userId: 'buyer', courseId: 'course', sourceType: 'membership', sourceId: 'line', startsAt: start, endsAt: end, graceEndsAt: null, status: 'active' }],
    serviceGrants: [{ id: 'service-grant', userId: 'buyer', definitionId: 'definition', sourceType: 'membership', sourceId: 'line', startsAt: start, endsAt: end, status: 'active', valueType: 'metered', resetPeriod: 'membership_term', booleanValue: null, quota: 10n, quotaPoolId: null }],
    effects: [
      { effectType: 'MEMBERSHIP_TERM', sourceId: 'version', resourceType: 'membership_subscription', resourceId: 'subscription' },
      { effectType: 'MEMBERSHIP_COURSE_ACCESS', sourceId: 'course', resourceType: 'course_access_grant', resourceId: 'course-grant' },
      { effectType: 'MEMBERSHIP_SERVICE_ACCESS', sourceId: 'definition', resourceType: 'service_entitlement_grant', resourceId: 'service-grant' },
    ], usage: [],
  };
}
describe('Historical membership reconciliation', () => {
  it('reconciles an expired purchased term without extending validity or resetting usage', () => {
    const input = facts(); input.usage.push({ grantId: 'service-grant', userId: 'buyer', quantity: 3n, periodStartsAt: start, periodEndsAt: end });
    const before = structuredClone(input);
    expect(reconcileLegacyMembership(input)).toMatchObject({ status: 'reconciled', findings: [], readOnly: true });
    expect(input).toEqual(before);
  });
  it('does not accept a subscription as payment proof', () => {
    const input = facts(); input.sourceVerified = false;
    expect(reconcileLegacyMembership(input)).toMatchObject({ status: 'blocked', findings: [{ code: 'SOURCE_NOT_VERIFIED' }] });
  });
  it('reports missing grants and their immutable source instead of silently granting access', () => {
    const input = facts(); input.courseGrants = [];
    expect(reconcileLegacyMembership(input).findings).toContainEqual({ code: 'COURSE_GRANT_MISSING', resourceId: 'course' });
  });
  it('flags a different owner or changed dates even when a grant id exists', () => {
    const input = facts(); input.courseGrants[0].userId = 'other'; input.serviceGrants[0].endsAt = null;
    expect(reconcileLegacyMembership(input).findings.map(item => item.code)).toEqual(expect.arrayContaining(['COURSE_GRANT_MISMATCH', 'SERVICE_GRANT_MISMATCH']));
  });
  it('never treats revoked access as a missing grant to recreate', () => {
    const input = facts(); input.courseGrants[0].status = 'revoked';
    const codes = reconcileLegacyMembership(input).findings.map(item => item.code);
    expect(codes).toContain('COURSE_GRANT_REVOKED'); expect(codes).not.toContain('COURSE_GRANT_MISSING');
  });
  it('checks effect-to-resource identity and unexpected source grants', () => {
    const input = facts(); input.effects[1].resourceId = 'other';
    input.courseGrants.push({ ...input.courseGrants[0], id: 'extra', courseId: 'unexpected' });
    expect(reconcileLegacyMembership(input).findings.map(item => item.code)).toEqual(expect.arrayContaining(['FULFILLMENT_EFFECT_MISMATCH', 'UNEXPECTED_COURSE_GRANT']));
  });
  it('holds quota anomalies and pooled usage for review instead of resetting consumption', () => {
    const input = facts(); input.serviceGrants[0].quotaPoolId = 'pool';
    input.usage.push({ grantId: 'service-grant', userId: 'other', quantity: 0n, periodStartsAt: start, periodEndsAt: end });
    expect(reconcileLegacyMembership(input).findings.map(item => item.code)).toEqual(expect.arrayContaining(['SHARED_QUOTA_REQUIRES_REVIEW', 'SERVICE_USAGE_MISMATCH']));
  });
  it('rejects invalid purchased windows before comparing rights', () => {
    const input = facts(); input.endsAt = start;
    expect(reconcileLegacyMembership(input).status).toBe('blocked');
  });
  it('reports overspent quota across usages in the same original period', () => {
    const input = facts();
    input.usage = [6n, 5n].map(quantity => ({ grantId: 'service-grant', userId: 'buyer', quantity, periodStartsAt: start, periodEndsAt: end }));
    expect(reconcileLegacyMembership(input).findings.map(item => item.code)).toContain('SERVICE_QUOTA_EXCEEDED');
  });
  it('reports a fabricated period that would hide previously consumed quota', () => {
    const input = facts();
    input.usage.push({ grantId: 'service-grant', userId: 'buyer', quantity: 1n, periodStartsAt: new Date('2025-01-02Z'), periodEndsAt: end });
    expect(reconcileLegacyMembership(input).findings.map(item => item.code)).toContain('SERVICE_USAGE_MISMATCH');
  });
});
