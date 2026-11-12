import type { Prisma } from '../../../generated/prisma/client';
import { evaluateMembershipCard, type MembershipCardPolicy } from './membership-card.evaluator';

type SourceClient = Pick<Prisma.TransactionClient, 'commerceOrder' | 'user'>;
const MAX_SOURCE_ORDERS = 10000;
const spendSelect = {
  id: true, status: true, fulfillmentStatus: true, buyerId: true, currency: true,
  payableAmountMinor: true, confirmedSettlementId: true,
  confirmedSettlement: { select: { id: true, orderId: true, amountMinor: true, currency: true, settledAt: true, kind: true, disposition: true } },
  refunds: { where: { status: 'recorded' as const }, select: { id: true, settlementId: true, currency: true, status: true, amountMinor: true, recordedAt: true } },
} satisfies Prisma.CommerceOrderSelect;

export async function computeMembershipCardForUser(client: SourceClient, policy: MembershipCardPolicy,
  revisionId: string | null, userId: string, at = new Date()) {
  if (!policy.enabled || policy.basis === 'topup') return evaluateMembershipCard(policy, revisionId, [], at);
  const orders = await client.commerceOrder.findMany({
    where: { buyerId: userId, status: 'confirmed', fulfillmentStatus: 'fulfilled' },
    orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: spendSelect,
  });
  if (orders.length > MAX_SOURCE_ORDERS) return { ...evaluateMembershipCard(policy, revisionId, [], at), status: 'unavailable' as const, reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', tier: null, qualifyingAmountMinor: null };
  return evaluateMembershipCard(policy, revisionId, orders, at);
}

/** Call inside a RepeatableRead transaction for a coherent read-only impact page. */
export async function computeMembershipCardImpact(client: SourceClient, policy: MembershipCardPolicy, revisionId: string,
  options: { after?: string; pageSize?: number; at?: Date; beforePolicy?: MembershipCardPolicy; beforeRevisionId?: string | null } = {}) {
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 50));
  const at = options.at ?? new Date();
  const policyProbe = evaluateMembershipCard(policy, revisionId, [], at);
  if (policyProbe.status === 'unavailable') return { status: 'unavailable', reason: policyProbe.reason,
    policyRevisionId: revisionId, preservesPurchasedAccess: true, items: [], nextCursor: null, complete: false,
    activationReady: false, activationBlockers: [policyProbe.reason] };
  const count = await client.user.count({ where: { deletedAt: null } });
  const users = await client.user.findMany({ where: { deletedAt: null, ...(options.after ? { id: { gt: options.after } } : {}) },
    orderBy: { id: 'asc' }, take: pageSize + 1, select: { id: true } });
  const hasNextPage = users.length > pageSize;
  const selected = users.slice(0, pageSize);
  const orders = policy.enabled && policy.basis === 'spend' ? await client.commerceOrder.findMany({
    where: { buyerId: { in: selected.map(user => user.id) }, status: 'confirmed', fulfillmentStatus: 'fulfilled' },
    orderBy: { id: 'asc' }, take: MAX_SOURCE_ORDERS + 1, select: spendSelect,
  }) : [];
  if (orders.length > MAX_SOURCE_ORDERS) return { status: 'unavailable', reason: 'SOURCE_SCAN_LIMIT_EXCEEDED', policyRevisionId: revisionId, preservesPurchasedAccess: true, totalUsers: count, items: [], nextCursor: null, complete: false };
  const items = selected.map(user => {
    const source = orders.filter(order => order.buyerId === user.id);
    const evaluation = evaluateMembershipCard(policy, revisionId, source, at);
    const previous = options.beforePolicy ? evaluateMembershipCard(options.beforePolicy, options.beforeRevisionId ?? null, source, at) : null;
    return { userId: user.id, evaluation, previousTierCode: previous?.tier?.code ?? null,
      projectedTierChanged: previous && previous.status !== 'unavailable' && evaluation.status === 'evaluated' ? previous.tier?.code !== evaluation.tier?.code : null };
  });
  return { status: items.some(item => item.evaluation.status === 'unavailable') ? 'unavailable' : 'evaluated',
    reason: items.find(item => item.evaluation.status === 'unavailable')?.evaluation.reason ?? null,
    policyRevisionId: revisionId, preservesPurchasedAccess: true, totalUsers: count, evaluatedUsers: items.length,
    projectedChangesOnPage: items.filter(item => item.projectedTierChanged === true).length,
    items, nextCursor: hasNextPage ? selected[selected.length - 1]?.id ?? null : null,
    complete: !hasNextPage && !options.after, evaluatedAt: at.toISOString(),
    activationReady: false, activationBlockers: ['LEGACY_ENTITLEMENT_MIGRATION_NOT_VERIFIED', 'CARD_BENEFIT_FULFILLMENT_NOT_VERIFIED'] };
}
