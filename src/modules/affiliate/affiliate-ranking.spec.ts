import { computeAffiliateRanking, computeAffiliateRankingImpact, loadEffectiveAffiliatePolicy, selfAffiliateRanking } from './affiliate-ranking';
import { DEFAULT_AFFILIATE_RANKING } from './affiliate-ranking.policy';
const asOf = new Date('2030-03-02T12:00:00Z');
const ranking = { enabled: true, basis: 'recorded_signed_commission' as const, period: 'lifetime' as const, tiePolicy: 'competition' as const };
function source() {
  return { user: { findMany: jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }, { id: 'zero' }, { id: 'negative' }]) },
    affiliateAccrual: { findMany: jest.fn().mockResolvedValue([
      ...['one', 'two'].map(ownerId => ({ deltaMinor: 900719925474099300n, currency: 'VND', createdAt: new Date('2030-03-01'), attribution: { identity: { ownerId } } })),
      { deltaMinor: -3n, currency: 'VND', createdAt: new Date('2030-03-01'), attribution: { identity: { ownerId: 'negative' } } },
    ]) }, affiliateAttribution: { findMany: jest.fn().mockResolvedValue([]) },
    platformPolicyRevision: { findFirst: jest.fn().mockResolvedValue(null) } };
}
it('keeps exact BigInt competition ties, zero and negatives and exposes only self rank', async () => {
  const db = source(); const result = await computeAffiliateRanking(db as any, ranking, asOf);
  expect([...result.ranks.values()]).toEqual([1, 1, 3, 4]);
  const self = selfAffiliateRanking(result, ranking, 'revision', 'zero', asOf);
  expect(self).toMatchObject({ status: 'available', value: 3, complete: true, policyRevisionId: 'revision' });
  expect(JSON.stringify(self)).not.toContain('negative'); expect(self).not.toHaveProperty('scores');
  expect(selfAffiliateRanking(result, ranking, 'revision', 'outsider', asOf)).toMatchObject({ status: 'not_participating', value: null });
  expect(db.user.findMany.mock.calls[0][0]).toMatchObject({ take: 10001, select: { id: true }, where: { status: 'active', deletedAt: null,
    OR: [{ affiliateIdentities: { some: { kind: 'general', status: 'active', createdAt: { lt: asOf } } } },
      { affiliateIdentities: { some: { kind: 'instructor', status: 'active', createdAt: { lt: asOf } } }, roles: { some: { role: { name: 'instructor' } } } }] } });
});
it.each(['population', 'source'])('refuses partial %s', async kind => {
  const db = source();
  if (kind === 'population') db.user.findMany.mockImplementation(async ({ take }) => Array(take).fill({ id: 'one' }));
  else db.affiliateAccrual.findMany.mockImplementation(async ({ take }) => Array(take).fill({}));
  expect(await computeAffiliateRanking(db as any, ranking, asOf)).toMatchObject({ complete: false, ranks: new Map(),
    reason: kind === 'population' ? 'RANKING_POPULATION_SCAN_LIMIT_EXCEEDED' : 'RANKING_SOURCE_SCAN_LIMIT_EXCEEDED' });
});
it.each([
  ['utc_day', new Date('2030-03-02T00:00:00Z')],
  ['utc_month', new Date('2030-03-01T00:00:00Z')], ['lifetime', null],
] as const)('uses exclusive asOf and exact UTC %s window', async (period, startsAt) => {
  const db = source(); db.affiliateAccrual.findMany.mockResolvedValue([]);
  const p = { ...ranking, period };
  const result = await computeAffiliateRanking(db as any, p, asOf);
  const self = selfAffiliateRanking(result, p, 'revision', 'one', asOf);
  expect(self).toMatchObject({ value: 1, complete: true, startsAt: startsAt?.toISOString() ?? null, endsBefore: asOf.toISOString() });
  expect(db.affiliateAccrual.findMany.mock.calls[0][0].where.createdAt).toEqual({ lt: asOf, ...(startsAt ? { gte: startsAt } : {}) });
});
it('sums multiple historical identity postings for one qualified owner without creating extra participants', async () => {
  const db = source(); db.affiliateAccrual.findMany.mockResolvedValue([
    ...[10n, 15n, -5n].map(deltaMinor => ({ deltaMinor, currency: 'VND', createdAt: new Date('2030-03-01'), attribution: { identity: { ownerId: 'one' } } })),
    { deltaMinor: 20n, currency: 'VND', createdAt: new Date('2030-03-01'), attribution: { identity: { ownerId: 'two' } } },
  ]);
  const result = await computeAffiliateRanking(db as any, ranking, asOf);
  expect(result.examinedParticipants).toBe(4); expect([...result.ranks.values()]).toEqual([1, 1, 3, 3]);
  expect(db.user.findMany).toHaveBeenCalledTimes(1); expect(db.affiliateAccrual.findMany).toHaveBeenCalledTimes(1);
  expect(db.affiliateAccrual.findMany.mock.calls[0][0].where.attribution.identity).toEqual({ ownerId: { in: ['one', 'two', 'zero', 'negative'] } });
});
it('compares only shared ranked participants and reports removal when disabled', async () => {
  const db = source();
  const after = { ...ranking, basis: 'recorded_referral_count' as const };
  db.affiliateAttribution.findMany.mockResolvedValue([{ orderId: 'one-order', identity: { ownerId: 'one' }, createdAt: new Date('2030-03-01') }]);
  expect(await computeAffiliateRankingImpact(db as any, ranking, after, 'before', 'after', asOf)).toMatchObject({
    complete: true, newlyRanked: 0, removedParticipants: 0, changedRanks: 3, unchangedRanks: 1 });
  expect(await computeAffiliateRankingImpact(db as any, ranking, { ...ranking, enabled: false }, 'before', 'after', asOf)).toMatchObject({
    complete: true, newlyRanked: 0, removedParticipants: 4, changedRanks: 0, unchangedRanks: 0 });
});
it.each(['currency', 'future', 'owner', 'amount'])('refuses invalid %s source evidence without leaking partial rank', async kind => {
  const db = source(); const row = { deltaMinor: 2n, currency: 'VND', createdAt: new Date('2030-03-01'), attribution: { identity: { ownerId: 'one' } } };
  if (kind === 'currency') row.currency = 'USD';
  if (kind === 'future') row.createdAt = asOf;
  if (kind === 'owner') row.attribution.identity.ownerId = 'outside';
  if (kind === 'amount') (row as any).deltaMinor = '2';
  db.affiliateAccrual.findMany.mockResolvedValue([row]);
  expect(await computeAffiliateRanking(db as any, ranking, asOf)).toMatchObject({ complete: false, reason: 'RANKING_SOURCE_INVALID', ranks: new Map() });
});
it('uses UTC windows, excludes future evidence and counts unique recorded orders across historical identities', async () => {
  const db = source(); db.affiliateAttribution.findMany.mockResolvedValue([
    { orderId: 'a', identity: { ownerId: 'one' }, createdAt: new Date('2030-03-02T00:00:00Z') },
    { orderId: 'a', identity: { ownerId: 'one' }, createdAt: new Date('2030-03-02T01:00:00Z') },
  ]);
  const p = { ...ranking, basis: 'recorded_referral_count' as const, period: 'utc_day' as const };
  const result = await computeAffiliateRanking(db as any, p, asOf);
  expect(result.ranks.get('two')).toBe(2);
  expect(db.affiliateAttribution.findMany.mock.calls[0][0].where).toEqual({ identity: { ownerId: { in: ['one', 'two', 'zero', 'negative'] } }, createdAt: { gte: new Date('2030-03-02'), lt: asOf } });
  db.affiliateAttribution.findMany.mockResolvedValue([{ orderId: 'future', identity: { ownerId: 'one' }, createdAt: asOf }]);
  expect(await computeAffiliateRanking(db as any, p, asOf)).toMatchObject({ complete: false, reason: 'RANKING_SOURCE_INVALID' });
});
it('pairs new ranks without rank zero and makes a failed old side incomparable while allowing disable recovery', async () => {
  const db = source();
  expect(await computeAffiliateRankingImpact(db as any, DEFAULT_AFFILIATE_RANKING, ranking, 'before', 'after', asOf)).toMatchObject({
    complete: true, comparable: true, newlyRanked: 4, changedRanks: 0, unchangedRanks: 0 });
  db.affiliateAccrual.findMany.mockRejectedValue(new Error('private database details'));
  const impact = await computeAffiliateRankingImpact(db as any, ranking, DEFAULT_AFFILIATE_RANKING, 'before', 'after', asOf);
  expect(impact).toMatchObject({ complete: false, comparable: false, newlyRanked: null, changedRanks: null, activationReady: true, activationBlockers: [],
    exceptions: [{ side: 'before', reason: 'RANKING_SOURCE_UNAVAILABLE', count: 1 }] });
  expect(JSON.stringify(impact)).not.toContain('private');
  expect(await computeAffiliateRankingImpact(db as any, DEFAULT_AFFILIATE_RANKING, ranking, null, 'after', asOf)).toMatchObject({ activationReady: false, activationBlockers: ['RANKING_SOURCE_UNAVAILABLE'] });
});
it('resolves effective revision using captured asOf rather than future scheduled policy', async () => {
  const db = source(); await loadEffectiveAffiliatePolicy(db as any, asOf);
  expect(db.platformPolicyRevision.findFirst).toHaveBeenCalledWith({ where: { group: 'affiliate', status: 'scheduled', effectiveAt: { lte: asOf } }, orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }] });
});
