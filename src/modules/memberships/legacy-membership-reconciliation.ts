import { entitlementUsageWindow, normalizeEntitlementValue, type EntitlementResetPeriod, type EntitlementValueType } from './service-entitlement.rules';

type Window = { startsAt: Date; endsAt: Date | null };
type CourseSource = Window & { courseId: string; sourceType: string; sourceId: string };
type ServiceValue = { definitionId: string; valueType: string; resetPeriod: string; booleanValue: boolean | null; quota: bigint | null };
export interface LegacyMembershipFacts {
  orderId: string; buyerId: string; lineId: string; versionId: string; sourceVerified: boolean;
  startsAt: Date; endsAt: Date;
  subscription: null | { id: string; userId: string; versionId: string; sourceOrderLineId: string | null; startsAt: Date; expiresAt: Date; status: string };
  courses: CourseSource[];
  services: ServiceValue[];
  courseGrants: Array<CourseSource & { id: string; userId: string; status: string; graceEndsAt: Date | null }>;
  serviceGrants: Array<Window & ServiceValue & { id: string; userId: string; sourceType: string; sourceId: string; status: string; quotaPoolId: string | null }>;
  effects: Array<{ effectType: string; sourceId: string; resourceType: string; resourceId: string }>;
  usage: Array<{ grantId: string; userId: string; quantity: bigint; periodStartsAt: Date; periodEndsAt: Date | null }>;
}
const sameDate = (a: Date | null, b: Date | null) => a === null ? b === null : b !== null && Number.isFinite(a.getTime()) && a.getTime() === b.getTime();
const validWindow = (start: Date, end: Date | null) => Number.isFinite(start.getTime()) && end !== null && Number.isFinite(end.getTime()) && end > start;

/** Compares existing rights only. Never treats a finding as authorization to grant/revoke. */
export function reconcileLegacyMembership(input: LegacyMembershipFacts) {
  const findings: Array<{ code: string; resourceId?: string }> = [];
  const report = (status: 'blocked' | 'attention' | 'reconciled') => ({
    orderId: input.orderId, orderLineId: input.lineId, status, readOnly: true as const,
    purchasedAccessPreserved: true as const, findings,
  });
  const add = (code: string, resourceId?: string) => findings.push(resourceId ? { code, resourceId } : { code });
  if (!input.sourceVerified) { add('SOURCE_NOT_VERIFIED'); return report('blocked'); }
  if (!validWindow(input.startsAt, input.endsAt) || input.courses.some(course => !validWindow(course.startsAt, course.endsAt))) {
    add('INVALID_PURCHASE_WINDOW'); return report('blocked');
  }
  try {
    for (const service of input.services) {
      if (!['none', 'calendar_month', 'membership_term'].includes(service.resetPeriod)) throw new Error('Invalid reset period');
      normalizeEntitlementValue(service.valueType as EntitlementValueType, service.resetPeriod as EntitlementResetPeriod, service.booleanValue, service.quota);
    }
  } catch { add('INVALID_SERVICE_SNAPSHOT'); return report('blocked'); }
  const checkEffect = (effectType: string, sourceId: string, resourceType: string, resourceId: string) => {
    const effects = input.effects.filter(effect => effect.effectType === effectType && effect.sourceId === sourceId);
    if (effects.length !== 1 || effects[0].resourceType !== resourceType || effects[0].resourceId !== resourceId) add('FULFILLMENT_EFFECT_MISMATCH', resourceId);
  };
  const subscription = input.subscription;
  if (!subscription) add('SUBSCRIPTION_MISSING');
  else {
    if (subscription.userId !== input.buyerId || subscription.versionId !== input.versionId || subscription.sourceOrderLineId !== input.lineId
      || !sameDate(subscription.startsAt, input.startsAt) || !sameDate(subscription.expiresAt, input.endsAt)) add('SUBSCRIPTION_MISMATCH', subscription.id);
    if (subscription.status !== 'active') add('SUBSCRIPTION_INACTIVE', subscription.id);
    checkEffect('MEMBERSHIP_TERM', input.versionId, 'membership_subscription', subscription.id);
  }
  for (const source of input.courses) {
    const grants = input.courseGrants.filter(grant => grant.courseId === source.courseId && grant.sourceType === source.sourceType && grant.sourceId === source.sourceId);
    if (!grants.length) { add('COURSE_GRANT_MISSING', source.courseId); continue; }
    for (const grant of grants) {
      if (grants.length !== 1 || grant.userId !== input.buyerId || !sameDate(grant.startsAt, source.startsAt)
        || !sameDate(grant.endsAt, source.endsAt) || grant.graceEndsAt !== null) add('COURSE_GRANT_MISMATCH', source.courseId);
      if (grant.status !== 'active') add('COURSE_GRANT_REVOKED', source.courseId);
      checkEffect(source.sourceType === 'membership_grace' ? 'MEMBERSHIP_GRACE_ACCESS' : 'MEMBERSHIP_COURSE_ACCESS', source.courseId, 'course_access_grant', grant.id);
    }
  }
  for (const grant of input.courseGrants) {
    if (!input.courses.some(source => source.courseId === grant.courseId && source.sourceType === grant.sourceType && source.sourceId === grant.sourceId)) add('UNEXPECTED_COURSE_GRANT', grant.id);
  }
  for (const source of input.services) {
    const grants = input.serviceGrants.filter(grant => grant.definitionId === source.definitionId && grant.sourceType === 'membership' && grant.sourceId === input.lineId);
    if (!grants.length) { add('SERVICE_GRANT_MISSING', source.definitionId); continue; }
    for (const grant of grants) {
      if (grants.length !== 1 || grant.userId !== input.buyerId || !sameDate(grant.startsAt, input.startsAt) || !sameDate(grant.endsAt, input.endsAt)
        || grant.valueType !== source.valueType || grant.resetPeriod !== source.resetPeriod || grant.booleanValue !== source.booleanValue || grant.quota !== source.quota) add('SERVICE_GRANT_MISMATCH', source.definitionId);
      if (grant.status !== 'active') add('SERVICE_GRANT_REVOKED', source.definitionId);
      if (grant.quotaPoolId) add('SHARED_QUOTA_REQUIRES_REVIEW', source.definitionId);
      checkEffect('MEMBERSHIP_SERVICE_ACCESS', source.definitionId, 'service_entitlement_grant', grant.id);
    }
  }
  for (const grant of input.serviceGrants) {
    if (!input.services.some(source => source.definitionId === grant.definitionId) || grant.sourceType !== 'membership' || grant.sourceId !== input.lineId) add('UNEXPECTED_SERVICE_GRANT', grant.id);
  }
  const expectedEffects = new Set([
    `MEMBERSHIP_TERM:${input.versionId}`,
    ...input.courses.map(source => `${source.sourceType === 'membership_grace' ? 'MEMBERSHIP_GRACE_ACCESS' : 'MEMBERSHIP_COURSE_ACCESS'}:${source.courseId}`),
    ...input.services.map(source => `MEMBERSHIP_SERVICE_ACCESS:${source.definitionId}`),
  ]);
  for (const effect of input.effects) {
    if (!expectedEffects.has(`${effect.effectType}:${effect.sourceId}`)) add('UNEXPECTED_FULFILLMENT_EFFECT', effect.resourceId);
  }
  const consumed = new Map<string, bigint>();
  for (const usage of input.usage) {
    const grant = input.serviceGrants.find(grant => grant.id === usage.grantId);
    if (!grant || usage.userId !== input.buyerId || usage.quantity <= 0n || !validWindow(usage.periodStartsAt, usage.periodEndsAt)
      || usage.periodStartsAt < grant.startsAt || (grant.endsAt && usage.periodEndsAt! > grant.endsAt)) { add('SERVICE_USAGE_MISMATCH', usage.grantId); continue; }
    const window = entitlementUsageWindow(grant.resetPeriod as EntitlementResetPeriod, grant.startsAt, grant.endsAt, usage.periodStartsAt);
    if (!sameDate(window.startsAt, usage.periodStartsAt) || !sameDate(window.endsAt, usage.periodEndsAt)) add('SERVICE_USAGE_MISMATCH', usage.grantId);
    const key = `${grant.id}:${usage.periodStartsAt.getTime()}:${usage.periodEndsAt?.getTime()}`;
    consumed.set(key, (consumed.get(key) ?? 0n) + usage.quantity);
    if (!grant.quotaPoolId && grant.quota !== null && consumed.get(key)! > grant.quota
      && !findings.some(item => item.code === 'SERVICE_QUOTA_EXCEEDED' && item.resourceId === grant.id)) add('SERVICE_QUOTA_EXCEEDED', grant.id);
  }
  return report(findings.length ? 'attention' : 'reconciled');
}
