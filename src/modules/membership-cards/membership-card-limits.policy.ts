import { BadRequestException } from '@nestjs/common';
import { isISO8601, isUUID } from 'class-validator';
import type { MembershipCardPolicy, MembershipCardTier } from './membership-card.evaluator';

export interface CardServiceLimitRule { definitionId: string; quota: string; }
export interface CardServiceLimitSettings {
  enabled: boolean;
  consumptionPriority: 'card_first' | 'purchased_first';
  termAnchorAt: string;
  termMonths: number;
}
export const DEFAULT_CARD_SERVICE_LIMITS: Readonly<CardServiceLimitSettings> = Object.freeze({
  enabled: false, consumptionPriority: 'purchased_first', termAnchorAt: '', termMonths: 0,
});

/** Add validation defaults to a copy only; historical stored revisions stay untouched. */
export function withCardServiceLimitDefaults(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const value = content as Record<string, unknown>;
  return { serviceLimits: { ...DEFAULT_CARD_SERVICE_LIMITS }, ...value,
    tiers: Array.isArray(value.tiers) ? value.tiers.map(tier =>
      tier && typeof tier === 'object' && !Array.isArray(tier) ? { serviceLimits: [], ...tier } : tier) : value.tiers };
}

export function validateCardServiceLimits(policy: MembershipCardPolicy): void {
  const settings = policy.serviceLimits ?? DEFAULT_CARD_SERVICE_LIMITS;
  const invalid = (reason: string): never => { throw new BadRequestException('Invalid card service limits: ' + reason); };
  if (!['card_first', 'purchased_first'].includes(settings.consumptionPriority)) invalid('consumption priority');
  if (!Number.isInteger(settings.termMonths) || settings.termMonths < 0 || settings.termMonths > 120) invalid('term duration');
  if (settings.termAnchorAt || settings.termMonths) {
    if (!settings.termMonths || !isISO8601(settings.termAnchorAt, { strict: true, strictSeparator: true })
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(settings.termAnchorAt)
      || !Number.isFinite(Date.parse(settings.termAnchorAt))) invalid('explicit fixed-term anchor and duration');
  }
  for (const tier of policy.tiers) {
    const definitions = new Set<string>();
    for (const rule of tier.serviceLimits ?? []) {
      if (!isUUID(rule.definitionId) || definitions.has(rule.definitionId.toLowerCase())) invalid('unique definition reference');
      definitions.add(rule.definitionId.toLowerCase());
      if (!/^[1-9][0-9]{0,18}$/.test(rule.quota) || BigInt(rule.quota) > 9_223_372_036_854_775_807n) invalid('positive supported quota');
    }
  }
}

export function cardServiceLimitDescriptor(policy: MembershipCardPolicy, tier: MembershipCardTier | null) {
  if (!policy.enabled || policy.serviceLimits?.enabled !== true || !tier?.serviceLimits?.length) return null;
  return { settings: policy.serviceLimits, rules: tier.serviceLimits };
}

type LimitWindow = { status: 'available'; startsAt: Date | null; endsAt: Date | null }
  | { status: 'unavailable'; reason: 'INVALID_SERVICE_LIMIT_DATE' | 'SERVICE_TERM_NOT_CONFIGURED' | 'SERVICE_TERM_NOT_STARTED' | 'UNSUPPORTED_SERVICE_RESET' };

function addUtcMonths(anchor: Date, months: number): Date {
  const result = new Date(anchor);
  const day = result.getUTCDate();
  result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(result); last.setUTCMonth(last.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, last.getUTCDate()));
  return result;
}

/** Fixed service periods never use the moving rolling rank-qualification window. */
export function cardServiceLimitWindow(resetPeriod: string, settings: Readonly<CardServiceLimitSettings>, at: Date): LimitWindow {
  if (!Number.isFinite(at.getTime())) return { status: 'unavailable', reason: 'INVALID_SERVICE_LIMIT_DATE' };
  if (resetPeriod === 'none') return { status: 'available', startsAt: null, endsAt: null };
  if (resetPeriod === 'calendar_month') {
    const startsAt = new Date(at); startsAt.setUTCDate(1); startsAt.setUTCHours(0, 0, 0, 0);
    const endsAt = new Date(startsAt); endsAt.setUTCMonth(endsAt.getUTCMonth() + 1);
    return { status: 'available', startsAt, endsAt };
  }
  if (resetPeriod !== 'membership_term') return { status: 'unavailable', reason: 'UNSUPPORTED_SERVICE_RESET' };
  const anchor = new Date(settings.termAnchorAt);
  if (!Number.isFinite(anchor.getTime()) || !Number.isInteger(settings.termMonths) || settings.termMonths < 1 || settings.termMonths > 120)
    return { status: 'unavailable', reason: 'SERVICE_TERM_NOT_CONFIGURED' };
  if (at < anchor) return { status: 'unavailable', reason: 'SERVICE_TERM_NOT_STARTED' };
  const months = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth();
  let period = Math.floor(months / settings.termMonths);
  if (addUtcMonths(anchor, period * settings.termMonths) > at) period -= 1;
  return { status: 'available', startsAt: addUtcMonths(anchor, period * settings.termMonths),
    endsAt: addUtcMonths(anchor, (period + 1) * settings.termMonths) };
}
