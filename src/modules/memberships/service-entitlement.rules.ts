export type EntitlementValueType = 'boolean' | 'metered' | 'unlimited';
export type EntitlementResetPeriod = 'none' | 'calendar_month' | 'membership_term';

export interface NormalizedEntitlementValue {
  valueType: EntitlementValueType;
  resetPeriod: EntitlementResetPeriod;
  booleanValue: boolean | null;
  quota: bigint | null;
}

export function normalizeEntitlementValue(
  valueType: EntitlementValueType,
  resetPeriod: EntitlementResetPeriod,
  booleanValue: boolean | null,
  quota: bigint | null,
): NormalizedEntitlementValue {
  const valid =
    (valueType === 'boolean' && resetPeriod === 'none' && booleanValue !== null && quota === null)
    || (valueType === 'metered' && booleanValue === null && quota !== null && quota > 0n)
    || (valueType === 'unlimited' && resetPeriod === 'none' && booleanValue === null && quota === null);
  if (!valid) throw new Error('Entitlement value does not match its declared semantics.');
  return { valueType, resetPeriod, booleanValue, quota };
}

export function entitlementUsageWindow(
  resetPeriod: EntitlementResetPeriod,
  grantStartsAt: Date,
  grantEndsAt: Date | null,
  at: Date,
): { startsAt: Date; endsAt: Date | null } {
  if (resetPeriod !== 'calendar_month') {
    return { startsAt: grantStartsAt, endsAt: grantEndsAt };
  }
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return {
    startsAt: monthStart < grantStartsAt ? grantStartsAt : monthStart,
    endsAt: grantEndsAt && grantEndsAt < nextMonth ? grantEndsAt : nextMonth,
  };
}
