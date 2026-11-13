import type { Prisma } from '../../../generated/prisma/client';
import type { MembershipCardPolicy, MembershipCardTier } from './membership-card.evaluator';
import { cardServiceLimitWindow } from './membership-card-limits.policy';
import { isBoundCardRequestDefinition } from './card-service-bindings';

type Client = Pick<Prisma.TransactionClient, 'serviceEntitlementDefinition' | 'serviceEntitlementUsage'>;
const MAX_USAGE_ROWS = 10000;
export interface QuotaProjection {
  definitionId: string; code: string; resetPeriod: string; quota: string; consumed: string; remaining: string;
  overLimit: boolean; periodStartsAt: string | null; periodEndsAt: string | null;
}

/** Bounded read-only projection within the impact page's RepeatableRead snapshot. */
export async function loadCardServiceImpact(client: Client, policies: MembershipCardPolicy[], userIds: string[], at: Date) {
  const active = policies.filter(policy => policy.enabled && policy.serviceLimits?.enabled);
  const ids = [...new Set(active.flatMap(policy => policy.tiers.flatMap(tier => tier.serviceLimits ?? []))
    .map(rule => rule.definitionId.toLowerCase()))];
  const configured = ids.length > 0;
  const issues: Array<{ definitionId?: string; reason: string }> = [];
  const definitions = configured ? await client.serviceEntitlementDefinition.findMany({ where: { id: { in: ids } },
    select: { id: true, code: true, valueType: true, unitLabel: true, resetPeriod: true } }) : [];
  for (const definitionId of ids) {
    const definition = definitions.find(item => item.id.toLowerCase() === definitionId);
    if (!definition || !isBoundCardRequestDefinition(definition)) {
      issues.push({ definitionId, reason: definition ? 'CARD_SERVICE_OPERATION_NOT_BOUND' : 'CARD_SERVICE_DEFINITION_NOT_FOUND' });
      continue;
    }
    for (const policy of active) {
      if (!policy.tiers.some(tier => tier.serviceLimits?.some(rule => rule.definitionId.toLowerCase() === definitionId))) continue;
      const window = cardServiceLimitWindow(definition.resetPeriod, policy.serviceLimits!, at);
      if (window.status === 'unavailable') issues.push({ definitionId, reason: window.reason });
    }
  }
  const usage = configured && !issues.length && userIds.length ? await client.serviceEntitlementUsage.findMany({
    where: { userId: { in: userIds }, grant: { sourceType: 'MEMBERSHIP_CARD', definitionId: { in: ids } } },
    orderBy: { id: 'asc' }, take: MAX_USAGE_ROWS + 1,
    select: { userId: true, quantity: true, createdAt: true, grant: { select: { definitionId: true } } },
  }) : [];
  if (usage.length > MAX_USAGE_ROWS) issues.push({ reason: 'CARD_SERVICE_USAGE_SCAN_LIMIT_EXCEEDED' });
  const complete = !issues.length;
  const project = (userId: string, policy: MembershipCardPolicy, tier: MembershipCardTier | null): QuotaProjection[] | null => {
    if (!policy.enabled || !policy.serviceLimits?.enabled || !tier?.serviceLimits?.length) return [];
    if (!complete) return null;
    return tier.serviceLimits.map(rule => {
      const definition = definitions.find(item => item.id.toLowerCase() === rule.definitionId.toLowerCase())!;
      const window = cardServiceLimitWindow(definition.resetPeriod, policy.serviceLimits!, at);
      if (window.status !== 'available') throw new Error('Card projection window changed within a snapshot');
      // Revoked grants and prior policies/tiers count; independent purchased/receipt grants were excluded at the query.
      const consumed = usage.filter(item => item.userId === userId && item.grant.definitionId === definition.id
        && (definition.resetPeriod === 'none' || (item.createdAt >= window.startsAt! && item.createdAt < window.endsAt!)))
        .reduce((sum, item) => sum + item.quantity, 0n);
      const quota = BigInt(rule.quota);
      return { definitionId: definition.id, code: definition.code, resetPeriod: definition.resetPeriod,
        quota: rule.quota, consumed: consumed.toString(), remaining: (quota > consumed ? quota - consumed : 0n).toString(),
        overLimit: consumed > quota, periodStartsAt: window.startsAt?.toISOString() ?? null, periodEndsAt: window.endsAt?.toISOString() ?? null };
    }).sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  };
  return { configured, complete, issues, project };
}
