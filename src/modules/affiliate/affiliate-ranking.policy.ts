import { BadRequestException } from '@nestjs/common';

export interface AffiliateRankingPolicy {
  enabled: boolean;
  basis: 'unconfigured' | 'recorded_signed_commission' | 'recorded_referral_count';
  period: 'unconfigured' | 'utc_day' | 'utc_month' | 'lifetime';
  tiePolicy: 'unconfigured' | 'competition';
}
export const DEFAULT_AFFILIATE_RANKING: AffiliateRankingPolicy = {
  enabled: false, basis: 'unconfigured', period: 'unconfigured', tiePolicy: 'unconfigured',
};
/** Only an absent whole field gets compatibility defaults; present bad values stay bad. */
export function withAffiliateRankingDefaults(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  return Object.prototype.hasOwnProperty.call(content, 'ranking') ? content
    : { ...content, ranking: { ...DEFAULT_AFFILIATE_RANKING } };
}
export function validateAffiliateRanking(value: unknown): asserts value is AffiliateRankingPolicy {
  const fail = () => { throw new BadRequestException('Invalid configuration: affiliate.ranking'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const c = value as AffiliateRankingPolicy;
  if (Object.keys(c).length !== 4 || !['enabled', 'basis', 'period', 'tiePolicy'].every(k => Object.prototype.hasOwnProperty.call(c, k))
    || typeof c.enabled !== 'boolean'
    || !['unconfigured', 'recorded_signed_commission', 'recorded_referral_count'].includes(c.basis)
    || !['unconfigured', 'utc_day', 'utc_month', 'lifetime'].includes(c.period)
    || !['unconfigured', 'competition'].includes(c.tiePolicy)
    || (c.enabled && [c.basis, c.period, c.tiePolicy].includes('unconfigured'))) fail();
}
