import type { Prisma } from '../../../generated/prisma/client';
import { DEFAULT_PLATFORM_SETTINGS } from '../platform/platform-settings.defaults';
import type { AffiliatePolicy } from './affiliate-domain';
import { DEFAULT_AFFILIATE_RANKING, type AffiliateRankingPolicy, validateAffiliateRanking, withAffiliateRankingDefaults } from './affiliate-ranking.policy';

// Independent technical caps, always with an extra-row probe. No partial ranks.
const PARTICIPANT_LIMIT = 10000;
const SOURCE_LIMIT = 100000;
export type AffiliateRankingSource = Pick<Prisma.TransactionClient, 'user' | 'affiliateAccrual' | 'affiliateAttribution'>;
type EffectiveSource = Pick<Prisma.TransactionClient, 'platformPolicyRevision'>;
export interface RankingResult {
  status: 'unconfigured' | 'disabled' | 'available' | 'unavailable';
  complete: boolean;
  reason: string | null;
  ranks: Map<string, number>;
  examinedParticipants: number | null;
}
export async function loadEffectiveAffiliatePolicy(db: EffectiveSource, asOf: Date) {
  const row = await db.platformPolicyRevision.findFirst({
    where: { group: 'affiliate', status: 'scheduled', effectiveAt: { lte: asOf } },
    orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
  });
  return { policy: withAffiliateRankingDefaults(row?.content ?? DEFAULT_PLATFORM_SETTINGS.affiliate) as AffiliatePolicy,
    revisionId: row?.id ?? null };
}
export function rankingWindow(policy: AffiliateRankingPolicy, asOf: Date) {
  return policy.period === 'utc_day' ? new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()))
    : policy.period === 'utc_month' ? new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1)) : null;
}
function unavailable(reason: string, examinedParticipants: number | null = null): RankingResult {
  return { status: 'unavailable', complete: false, reason, ranks: new Map(), examinedParticipants };
}
export async function computeAffiliateRanking(db: AffiliateRankingSource, policy: AffiliateRankingPolicy, asOf: Date): Promise<RankingResult> {
  try { validateAffiliateRanking(policy); } catch { return unavailable('RANKING_POLICY_INVALID'); }
  if (!Number.isFinite(asOf.getTime())) return unavailable('RANKING_SOURCE_INVALID');
  if (!policy.enabled) return { status: [policy.basis, policy.period, policy.tiePolicy].includes('unconfigured') ? 'unconfigured' : 'disabled',
    complete: true, reason: [policy.basis, policy.period, policy.tiePolicy].includes('unconfigured') ? 'RANKING_POLICY_NOT_CONFIGURED' : 'RANKING_DISABLED', ranks: new Map(), examinedParticipants: 0 };
  let examined: number | null = null;
  try {
    // Select distinct owners directly. A general identity is JWT-only; instructor
    // identities alone cannot preserve permission after the instructor role goes.
    const activeIdentity = { status: 'active', createdAt: { lt: asOf } };
    const owners = await db.user.findMany({ where: { status: 'active', deletedAt: null, OR: [
      { affiliateIdentities: { some: { ...activeIdentity, kind: 'general' } } },
      { affiliateIdentities: { some: { ...activeIdentity, kind: 'instructor' } }, roles: { some: { role: { name: 'instructor' } } } },
    ] }, orderBy: { id: 'asc' }, take: PARTICIPANT_LIMIT + 1, select: { id: true } });
    if (owners.length > PARTICIPANT_LIMIT) return unavailable('RANKING_POPULATION_SCAN_LIMIT_EXCEEDED');
    examined = owners.length;
    const scores = new Map(owners.map(owner => [owner.id, 0n]));
    const ownerId = { in: [...scores.keys()] };
    const start = rankingWindow(policy, asOf);
    const createdAt = { lt: asOf, ...(start ? { gte: start } : {}) };
    const validDate = (date: Date) => date instanceof Date && Number.isFinite(date.getTime()) && date < asOf && (!start || date >= start);
    if (owners.length && policy.basis === 'recorded_signed_commission') {
      // Retained historical identities remain sources for a currently qualified owner.
      const rows = await db.affiliateAccrual.findMany({ where: { attribution: { identity: { ownerId } }, createdAt },
        orderBy: { id: 'asc' }, take: SOURCE_LIMIT + 1,
        select: { deltaMinor: true, currency: true, createdAt: true, attribution: { select: { identity: { select: { ownerId: true } } } } } });
      if (rows.length > SOURCE_LIMIT) return unavailable('RANKING_SOURCE_SCAN_LIMIT_EXCEEDED', examined);
      for (const row of rows) {
        const id = row.attribution.identity.ownerId;
        if (!scores.has(id) || row.currency !== 'VND' || typeof row.deltaMinor !== 'bigint' || !validDate(row.createdAt))
          return unavailable('RANKING_SOURCE_INVALID', examined);
        scores.set(id, scores.get(id)! + row.deltaMinor);
      }
    } else if (owners.length) {
      const rows = await db.affiliateAttribution.findMany({ where: { identity: { ownerId }, createdAt },
        orderBy: { id: 'asc' }, take: SOURCE_LIMIT + 1,
        select: { orderId: true, createdAt: true, identity: { select: { ownerId: true } } } });
      if (rows.length > SOURCE_LIMIT) return unavailable('RANKING_SOURCE_SCAN_LIMIT_EXCEEDED', examined);
      const seen = new Map<string, string>();
      for (const row of rows) {
        const id = row.identity.ownerId;
        if (!scores.has(id) || !row.orderId || !validDate(row.createdAt) || (seen.has(row.orderId) && seen.get(row.orderId) !== id))
          return unavailable('RANKING_SOURCE_INVALID', examined);
        if (!seen.has(row.orderId)) scores.set(id, scores.get(id)! + 1n);
        seen.set(row.orderId, id);
      }
    }
    const ordered = [...scores.entries()].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0);
    const ranks = new Map<string, number>();
    let rank = 0;
    ordered.forEach(([id, score], index) => { if (!index || score !== ordered[index - 1][1]) rank = index + 1; ranks.set(id, rank); });
    return { status: 'available', complete: true, reason: null, ranks, examinedParticipants: examined };
  } catch { return unavailable('RANKING_SOURCE_UNAVAILABLE', examined); }
}
export function selfAffiliateRanking(result: RankingResult, policy: AffiliateRankingPolicy, policyRevisionId: string | null, ownerId: string, asOf: Date) {
  // Invalid present policy cannot leak unsupported metadata as a valid selection.
  let metadata = policy;
  try { validateAffiliateRanking(metadata); } catch { metadata = DEFAULT_AFFILIATE_RANKING; }
  const value = result.ranks.get(ownerId) ?? null;
  return { status: result.status === 'available' && value === null ? 'not_participating' as const : result.status,
    value, reason: result.status === 'available' && value === null ? 'RANKING_NOT_PARTICIPATING' : result.reason,
    policyRevisionId, basis: metadata.basis, period: metadata.period, tiePolicy: metadata.tiePolicy,
    asOf: asOf.toISOString(), timeZone: 'UTC' as const, startsAt: rankingWindow(metadata, asOf)?.toISOString() ?? null,
    endsBefore: asOf.toISOString(), complete: result.complete };
}
export async function computeAffiliateRankingImpact(db: AffiliateRankingSource, beforePolicy: AffiliateRankingPolicy, afterPolicy: AffiliateRankingPolicy,
  beforeRevisionId: string | null, afterRevisionId: string, asOf: Date) {
  const before = await computeAffiliateRanking(db, beforePolicy, asOf);
  const after = await computeAffiliateRanking(db, afterPolicy, asOf);
  const complete = before.complete && after.complete;
  const exceptions = ([['before', before], ['after', after]] as const).flatMap(([side, result]) =>
    result.complete ? [] : [{ side, reason: result.reason!, count: 1 }]);
  let newlyRanked = 0, removedParticipants = 0, changedRanks = 0, unchangedRanks = 0;
  if (complete) {
    for (const [id, rank] of after.ranks) {
      if (!before.ranks.has(id)) newlyRanked++;
      else if (before.ranks.get(id) === rank) unchangedRanks++;
      else changedRanks++;
    }
    for (const id of before.ranks.keys()) if (!after.ranks.has(id)) removedParticipants++;
  }
  const activationBlockers = after.complete ? [] : [after.reason!];
  return { beforeRevisionId, afterRevisionId, asOf: asOf.toISOString(), timeZone: 'UTC' as const,
    examinedParticipants: complete ? Math.max(before.examinedParticipants ?? 0, after.examinedParticipants ?? 0) : null,
    newlyRanked: complete ? newlyRanked : null, removedParticipants: complete ? removedParticipants : null,
    changedRanks: complete ? changedRanks : null, unchangedRanks: complete ? unchangedRanks : null,
    complete, comparable: complete, exceptions, activationReady: activationBlockers.length === 0, activationBlockers };
}
