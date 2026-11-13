import type { Prisma } from '../../../generated/prisma/client';
import { evaluateMembershipCard, type MembershipCardPolicy } from './membership-card.evaluator';
import { membershipTopupSelect, type MembershipTopup } from './membership-topup.evaluator';
import { samePlatformPolicyContent } from '../platform/platform-policy-content';
import { cardServiceLimitDescriptor } from './membership-card-limits.policy';
import { loadCardServiceImpact } from './card-service-impact';

type SourceClient = Pick<Prisma.TransactionClient, 'commerceOrder' | 'gdsInternalTopup' | 'user'>;
const MAX_SOURCE_ORDERS = 10000;
const spendSelect = {
  id: true, status: true, fulfillmentStatus: true, buyerId: true, currency: true,
  payableAmountMinor: true, confirmedSettlementId: true,
  confirmedSettlement: { select: { id: true, orderId: true, amountMinor: true, currency: true, settledAt: true, kind: true, disposition: true } },
  refunds: { where: { status: 'recorded' as const }, select: { id: true, settlementId: true, currency: true, status: true, amountMinor: true, recordedAt: true } },
} satisfies Prisma.CommerceOrderSelect;

export async function computeMembershipCardForUser(client: SourceClient, policy: MembershipCardPolicy,
  revisionId: string | null, userId: string, at = new Date()) {
  if (!policy.enabled) return evaluateMembershipCard(policy, revisionId, [], at);
  if (policy.basis === 'topup') {
    const topups = await client.gdsInternalTopup.findMany({ where: { buyerId: userId, status: 'CREDITED' },
      orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: membershipTopupSelect });
    if (topups.length > MAX_SOURCE_ORDERS) return { ...evaluateMembershipCard(policy, revisionId, [], at),
      status: 'unavailable' as const, reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', tier: null, qualifyingAmountMinor: null };
    return evaluateMembershipCard(policy, revisionId, [], at, topups);
  }
  const orders = await client.commerceOrder.findMany({
    where: { buyerId: userId, status: 'confirmed', fulfillmentStatus: 'fulfilled' },
    orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: spendSelect,
  });
  if (orders.length > MAX_SOURCE_ORDERS) return { ...evaluateMembershipCard(policy, revisionId, [], at), status: 'unavailable' as const, reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', tier: null, qualifyingAmountMinor: null };
  return evaluateMembershipCard(policy, revisionId, orders, at);
}

/** Call inside a RepeatableRead transaction for a coherent read-only impact page. */
export async function computeMembershipCardImpact(client: SourceClient & Pick<Prisma.TransactionClient, 'serviceEntitlementDefinition' | 'serviceEntitlementUsage'>, policy: MembershipCardPolicy, revisionId: string,
  options: { after?: string; pageSize?: number; at?: Date; beforePolicy?: MembershipCardPolicy; beforeRevisionId?: string | null } = {}) {
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 50));
  const at = options.at ?? new Date();
  const policyProbe = evaluateMembershipCard(policy, revisionId, [], at, []);
  if (policyProbe.status === 'unavailable') return { status: 'unavailable', reason: policyProbe.reason,
    policyRevisionId: revisionId, preservesPurchasedAccess: true, items: [], nextCursor: null, complete: false,
    simulationOnly: true };
  const count = await client.user.count({ where: { deletedAt: null } });
  const users = await client.user.findMany({ where: { deletedAt: null, ...(options.after ? { id: { gt: options.after } } : {}) },
    orderBy: { id: 'asc' }, take: pageSize + 1, select: { id: true } });
  const hasNextPage = users.length > pageSize;
  const selected = users.slice(0, pageSize);
  const needsBasis = (basis: MembershipCardPolicy['basis']) =>
    (policy.enabled && policy.basis === basis) || (options.beforePolicy?.enabled && options.beforePolicy.basis === basis);
  const orders = needsBasis('spend') ? await client.commerceOrder.findMany({
    where: { buyerId: { in: selected.map(user => user.id) }, status: 'confirmed', fulfillmentStatus: 'fulfilled' },
    orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: spendSelect,
  }) : [];
  const topups: MembershipTopup[] = needsBasis('topup') ? await client.gdsInternalTopup.findMany({
    where: { buyerId: { in: selected.map(user => user.id) }, status: 'CREDITED' },
    orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: membershipTopupSelect,
  }) : [];
  if (orders.length > MAX_SOURCE_ORDERS || topups.length > MAX_SOURCE_ORDERS) return { status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', policyRevisionId: revisionId, preservesPurchasedAccess: true, totalUsers: count, items: [], nextCursor: null, complete: false, simulationOnly: true };
  const quotaImpact = await loadCardServiceImpact(client, [policy, ...(options.beforePolicy ? [options.beforePolicy] : [])], selected.map(user => user.id), at);
  const items = selected.map(user => {
    const source = orders.filter(order => order.buyerId === user.id);
    const userTopups = topups.filter(topup => topup.buyerId === user.id);
    const evaluation = evaluateMembershipCard(policy, revisionId, source, at, userTopups);
    const previous = options.beforePolicy ? evaluateMembershipCard(options.beforePolicy, options.beforeRevisionId ?? null, source, at, userTopups) : null;
    const comparable = previous && previous.status !== 'unavailable' && evaluation.status !== 'unavailable';
    const previousBenefits = previous?.tier?.benefits ?? [];
    const previousServiceLimits = previous && options.beforePolicy
      ? cardServiceLimitDescriptor(options.beforePolicy, previous.tier) : null;
    const nextServiceLimits = cardServiceLimitDescriptor(policy, evaluation.tier);
    const previousServiceQuota = comparable && options.beforePolicy ? quotaImpact.project(user.id, options.beforePolicy, previous.tier) : null;
    const projectedServiceQuota = evaluation.status !== 'unavailable' ? quotaImpact.project(user.id, policy, evaluation.tier) : null;
    return { userId: user.id, evaluation, previousTierCode: previous?.tier?.code ?? null,
      previousBenefits: comparable ? previousBenefits : null,
      projectedBenefitsChanged: comparable ? !samePlatformPolicyContent(previousBenefits, evaluation.tier?.benefits ?? []) : null,
      previousServiceLimits: comparable ? previousServiceLimits : null,
      previousServiceQuota, projectedServiceQuota,
      projectedServiceRemainingChanged: previousServiceQuota !== null && projectedServiceQuota !== null
        ? !samePlatformPolicyContent(previousServiceQuota.map(item => [item.definitionId, item.remaining, item.periodStartsAt, item.periodEndsAt]),
          projectedServiceQuota.map(item => [item.definitionId, item.remaining, item.periodStartsAt, item.periodEndsAt])) : null,
      projectedServiceLimitsChanged: comparable ? !samePlatformPolicyContent(previousServiceLimits, nextServiceLimits) : null,
      projectedTierChanged: comparable ? previous.tier?.code !== evaluation.tier?.code : null };
  });
  const serviceConsumptionProjected = quotaImpact.configured && quotaImpact.complete
    && items.every(item => item.previousServiceQuota !== null && item.projectedServiceQuota !== null);
  return { status: items.some(item => item.evaluation.status === 'unavailable') || !quotaImpact.complete ? 'unavailable' : 'evaluated',
    reason: items.find(item => item.evaluation.status === 'unavailable')?.evaluation.reason ?? quotaImpact.issues[0]?.reason ?? null,
    policyRevisionId: revisionId, preservesPurchasedAccess: true, totalUsers: count, evaluatedUsers: items.length,
    projectedChangesOnPage: items.filter(item => item.projectedTierChanged === true).length,
    projectedBenefitChangesOnPage: items.filter(item => item.projectedBenefitsChanged === true).length,
    projectedServiceLimitChangesOnPage: items.filter(item => item.projectedServiceLimitsChanged === true).length,
    projectedServiceRemainingChangesOnPage: items.filter(item => item.projectedServiceRemainingChanged === true).length,
    serviceLimitImpactScope: serviceConsumptionProjected ? 'consumption_included' : 'configuration_only', serviceConsumptionProjected,
    serviceConsumptionProjectionIssues: quotaImpact.issues,
    items, nextCursor: hasNextPage ? selected[selected.length - 1]?.id ?? null : null,
    complete: !hasNextPage && !options.after && quotaImpact.complete && !items.some(item => item.evaluation.status === 'unavailable'), evaluatedAt: at.toISOString(),
    simulationOnly: true };
}
