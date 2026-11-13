import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client';
import { validatePlatformSettings } from '../platform/platform-settings.validation';
import type { MembershipCardPolicy } from './membership-card.evaluator';
import { computeMembershipCardForUser } from './membership-card-source';
import { cardServiceLimitWindow } from './membership-card-limits.policy';
import { isBoundCardRequestDefinition } from './card-service-bindings';

// Stable server operation identities; these are bindings, not configurable business quotas.
export { CARD_REQUEST_SERVICES } from './card-service-bindings';
export type CardServiceGrant = Prisma.ServiceEntitlementGrantGetPayload<{ include: { definition: true } }>;
type Client = Pick<Prisma.TransactionClient, 'platformPolicyRevision' | 'commerceOrder' | 'gdsInternalTopup'
  | 'user' | 'serviceEntitlementDefinition' | 'serviceEntitlementGrant'>;

/** Resolve read-only candidates inside the caller's snapshot. Empty IDs mean not yet provisioned. */
export async function resolveCardServiceQuota(client: Client, userId: string, code: string | undefined, at: Date) {
  const empty = { configured: false, priority: 'purchased_first' as 'purchased_first' | 'card_first', grants: [] as CardServiceGrant[] };
  const revision = await client.platformPolicyRevision.findFirst({
    where: { group: 'membership', status: 'scheduled', effectiveAt: { lte: at } },
    orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
    select: { id: true, content: true, effectiveAt: true },
  });
  if (!revision?.effectiveAt) return empty;
  const policy = revision.content as unknown as MembershipCardPolicy;
  if (!policy?.enabled || policy.serviceLimits?.enabled !== true) return empty;
  empty.configured = true;
  try { validatePlatformSettings('membership', policy); } catch { return empty; }
  const evaluation = await computeMembershipCardForUser(client, policy, revision.id, userId, at);
  if (evaluation.status !== 'evaluated' || !evaluation.tier || !evaluation.sourceDigest) return empty;
  const rules = evaluation.tier.serviceLimits ?? [];
  if (!rules.length) return { ...empty, priority: policy.serviceLimits.consumptionPriority };
  const definitions = await client.serviceEntitlementDefinition.findMany({
    where: { id: { in: rules.map(rule => rule.definitionId) }, ...(code ? { code } : {}) },
    orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
  });
  const persisted = await client.serviceEntitlementGrant.findMany({
    where: { userId, sourceType: 'MEMBERSHIP_CARD', cardPolicyRevisionId: revision.id,
      cardTierCode: evaluation.tier.code, definitionId: { in: definitions.map(item => item.id) } },
    include: { definition: true },
  });
  const grants: CardServiceGrant[] = [];
  for (const definition of definitions) {
    if (!isBoundCardRequestDefinition(definition)) continue;
    const rule = rules.find(item => item.definitionId.toLowerCase() === definition.id.toLowerCase());
    if (!rule) continue;
    const window = cardServiceLimitWindow(definition.resetPeriod, policy.serviceLimits, at);
    if (window.status !== 'available') continue;
    const startsAt = window.startsAt ?? revision.effectiveAt;
    const endsAt = window.endsAt;
    const previous = persisted.find(item => item.definitionId === definition.id && item.startsAt.getTime() === startsAt.getTime()
      && (item.endsAt?.getTime() ?? null) === (endsAt?.getTime() ?? null));
    if (previous) {
      if (previous.status === 'active') grants.push(previous);
      continue;
    }
    const sourceId = createHash('sha256').update(JSON.stringify({ revisionId: revision.id, tier: evaluation.tier.code,
      definitionId: definition.id, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null })).digest('hex');
    grants.push({ id: '', userId, definitionId: definition.id, definition, sourceType: 'MEMBERSHIP_CARD', sourceId,
      cardPolicyRevisionId: revision.id, cardTierCode: evaluation.tier.code, cardSourceDigest: evaluation.sourceDigest,
      cardQualification: { evaluatedAt: evaluation.evaluatedAt, windowStartsAt: evaluation.windowStartsAt,
        windowEndsAt: evaluation.windowEndsAt, qualifyingAmountMinor: evaluation.qualifyingAmountMinor,
        basis: evaluation.basis, currency: evaluation.currency },
      valueType: 'metered', resetPeriod: definition.resetPeriod, booleanValue: null, quota: BigInt(rule.quota),
      quotaPoolId: null, status: 'active', startsAt, endsAt, createdAt: at, revokedAt: null });
  }
  return { configured: true, priority: policy.serviceLimits.consumptionPriority, grants };
}

/** Called only by the existing Serializable consumption transaction after checking available quota. */
export async function provisionCardServiceGrant(client: Pick<Prisma.TransactionClient, 'serviceEntitlementGrant'>, candidate: CardServiceGrant) {
  if (candidate.id) return candidate;
  const { id: _id, definition: _definition, ...data } = candidate;
  await client.serviceEntitlementGrant.createMany({ data: [{ ...data, cardQualification: data.cardQualification as Prisma.InputJsonObject }], skipDuplicates: true });
  return client.serviceEntitlementGrant.findFirstOrThrow({
    where: { userId: candidate.userId, definitionId: candidate.definitionId, sourceType: 'MEMBERSHIP_CARD', sourceId: candidate.sourceId },
    include: { definition: true },
  });
}
