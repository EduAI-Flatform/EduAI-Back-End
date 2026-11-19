import { DEFAULT_AFFILIATE_RANKING, withAffiliateRankingDefaults, validateAffiliateRanking } from './affiliate-ranking.policy';

it('adds only absent old ranking without changing historical JSON', () => {
  const old = { enabled: true }, frozen = JSON.stringify(old);
  expect(withAffiliateRankingDefaults(old)).toEqual({ enabled: true, ranking: DEFAULT_AFFILIATE_RANKING });
  expect(JSON.stringify(old)).toBe(frozen);
  expect(withAffiliateRankingDefaults({ ranking: null })).toEqual({ ranking: null });
});
it.each([null, [], {}, { ...{ enabled: false, basis: 'unconfigured', period: 'unconfigured', tiePolicy: 'unconfigured' }, extra: 1 },
  { enabled: true, basis: 'unconfigured', period: 'lifetime', tiePolicy: 'competition' },
  { enabled: false, basis: 'wallet', period: 'lifetime', tiePolicy: 'competition' }])('rejects malformed present config %p', ranking => {
  expect(() => validateAffiliateRanking(ranking)).toThrow();
});
it('requires explicit supported selections when enabled', () => {
  expect(() => validateAffiliateRanking(DEFAULT_AFFILIATE_RANKING)).not.toThrow();
  expect(() => validateAffiliateRanking({ enabled: true, basis: 'recorded_signed_commission', period: 'utc_day', tiePolicy: 'competition' })).not.toThrow();
});
