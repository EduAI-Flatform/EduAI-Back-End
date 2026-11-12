export const SUPPORTED_POINT_EVENTS = ['course.completed'] as const;
export type ActivityPointOutcome = 'awarded' | 'disabled' | 'no_rule' | 'daily_cap' | 'expired_before_award';
export interface ActivityPointPolicy {
  enabled: boolean;
  expireAfterMonths: number;
  maxDaily: number;
  rules: Array<{ event: string; points: number }>;
}

/** Evaluates an already-selected, effective policy at the canonical event time. */
export function evaluateActivityPointAward(
  policy: ActivityPointPolicy, event: string, occurredAt: Date, processedAt: Date, awardedToday: number,
): { outcome: ActivityPointOutcome; amount: number; expiresAt: Date } {
  if (!SUPPORTED_POINT_EVENTS.some(supported => supported === event)) throw new Error('POINT_ACTIVITY_EVENT_UNSUPPORTED');
  if (!Number.isFinite(occurredAt.getTime()) || !Number.isFinite(processedAt.getTime()) || processedAt < occurredAt)
    throw new Error('POINT_ACTIVITY_DATE_INVALID');
  if (!Number.isSafeInteger(awardedToday) || awardedToday < 0) throw new Error('POINT_ACTIVITY_DAILY_TOTAL_INVALID');
  if (typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.expireAfterMonths)
    || policy.expireAfterMonths < 1 || policy.expireAfterMonths > 120
    || !Number.isSafeInteger(policy.maxDaily) || policy.maxDaily < 0 || policy.maxDaily > 1000000
    || !Array.isArray(policy.rules) || new Set(policy.rules.map(rule => rule.event)).size !== policy.rules.length
    || policy.rules.some(rule => !SUPPORTED_POINT_EVENTS.some(supported => supported === rule.event)
      || !Number.isSafeInteger(rule.points) || rule.points < 0 || rule.points > 1000000))
    throw new Error('POINT_ACTIVITY_POLICY_INVALID');

  const expiresAt = new Date(occurredAt);
  const day = expiresAt.getUTCDate();
  expiresAt.setUTCDate(1);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + policy.expireAfterMonths);
  const lastDay = new Date(expiresAt);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  expiresAt.setUTCDate(Math.min(day, lastDay.getUTCDate()));

  if (!policy.enabled) return { outcome: 'disabled', amount: 0, expiresAt };
  const rule = policy.rules.find(rule => rule.event === event);
  if (!rule || rule.points === 0) return { outcome: 'no_rule', amount: 0, expiresAt };
  if (expiresAt <= processedAt) return { outcome: 'expired_before_award', amount: 0, expiresAt };
  const amount = policy.maxDaily === 0 ? rule.points : Math.min(rule.points, Math.max(0, policy.maxDaily - awardedToday));
  return { outcome: amount > 0 ? 'awarded' : 'daily_cap', amount, expiresAt };
}
