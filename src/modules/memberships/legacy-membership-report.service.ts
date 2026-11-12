import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isPaymentProviderName } from '../payments/payment-provider';
import { reconcileLegacyMembership } from './legacy-membership-reconciliation';

const COMPONENT_LIMIT = 250;
const HISTORY_LIMIT = 1000;
const orderInclude = {
  lines: { take: 2, orderBy: { id: 'asc' } },
  refunds: { take: 1, select: { id: true } },
  confirmedSettlement: { include: {
    paymentAttempt: { select: { id: true, orderId: true, provider: true, providerPaymentIdentity: true, providerOrderCode: true, status: true, amountMinor: true, currency: true } },
    paymentEvent: { select: { id: true, paymentAttemptId: true, provider: true, providerPaymentIdentity: true, providerSettlementReference: true, amountMinor: true, currency: true, nextStatus: true, providerOccurredAt: true } },
  } },
  membershipCheckoutIntent: { include: {
    version: { include: {
      includedCourses: { take: COMPONENT_LIMIT + 1, orderBy: { courseId: 'asc' } },
      serviceEntitlements: { take: COMPONENT_LIMIT + 1, orderBy: { definitionId: 'asc' } },
    } },
    removedCourses: { take: COMPONENT_LIMIT + 1, orderBy: { courseId: 'asc' } },
  } },
  fulfillmentEffects: { take: HISTORY_LIMIT + 1, orderBy: { id: 'asc' } },
} satisfies Prisma.CommerceOrderInclude;
type Order = Prisma.CommerceOrderGetPayload<{ include: typeof orderInclude }>;

/** Historical gateway evidence only; unsupported collection types require separate reconciliation. */
function gatewayProofMatches(order: Order): boolean {
  const settlement = order.confirmedSettlement;
  const attempt = settlement?.paymentAttempt;
  const event = settlement?.paymentEvent;
  return Boolean(settlement && attempt && event && isPaymentProviderName(settlement.provider)
    && order.confirmedSettlementId === settlement.id && settlement.orderId === order.id
    && settlement.kind === 'provider_collection' && settlement.disposition === 'matched'
    && settlement.amountMinor === order.payableAmountMinor && settlement.currency === order.currency
    && settlement.amountMinor > 0n && settlement.providerSettlementReference
    && Number.isFinite(settlement.settledAt.getTime())
    && settlement.paymentAttemptId === attempt.id && attempt.orderId === order.id
    && attempt.provider === settlement.provider && attempt.status === 'paid' && attempt.providerPaymentIdentity
    && attempt.providerOrderCode !== null && attempt.amountMinor === settlement.amountMinor && attempt.currency === settlement.currency
    && settlement.paymentEventId === event.id && event.paymentAttemptId === attempt.id && event.provider === settlement.provider
    && event.providerPaymentIdentity === attempt.providerPaymentIdentity && event.providerSettlementReference === settlement.providerSettlementReference
    && event.amountMinor === settlement.amountMinor && event.currency === settlement.currency && event.nextStatus === 'paid'
    && event.providerOccurredAt?.getTime() === settlement.settledAt.getTime());
}

async function walletProofMatches(tx: Prisma.TransactionClient, order: Order): Promise<boolean> {
  const settlement = order.confirmedSettlement;
  if (!settlement || settlement.kind !== 'wallet_capture' || settlement.disposition !== 'internal' || settlement.provider !== 'gds'
    || settlement.id !== order.confirmedSettlementId || settlement.orderId !== order.id || settlement.currency !== 'VND' || order.currency !== 'VND'
    || settlement.amountMinor !== order.payableAmountMinor || settlement.amountMinor <= 0n || settlement.paymentAttemptId !== null || settlement.paymentEventId !== null
    || settlement.providerSettlementReference !== `gds:order:${order.id}` || !Number.isFinite(settlement.settledAt.getTime())) return false;
  const [hold, journal] = await Promise.all([
    tx.gdsInternalHold.findUnique({ where: { orderRef: order.id }, include: { wallet: { select: { buyerId: true } } } }),
    tx.gdsInternalJournal.findUnique({ where: { eventKey: `gds:capture:${order.id}` } }),
  ]);
  return Boolean(hold && journal && hold.wallet.buyerId === order.buyerId && hold.status === 'CAPTURED' && hold.amountMinor === settlement.amountMinor
    && journal.walletId === hold.walletId && journal.kind === 'CAPTURE' && journal.orderRef === order.id && journal.amountMinor === settlement.amountMinor
    && journal.availableDeltaMinor === 0n && journal.heldDeltaMinor === -settlement.amountMinor && journal.clearingDeltaMinor === settlement.amountMinor);
}

@Injectable()
export class LegacyMembershipReportService {
  constructor(private readonly prisma: PrismaService) {}

  report(orderId: string) {
    // All reads observe one snapshot, including concurrent refunds/revocations.
    return this.prisma.$transaction(async tx => {
      const order = await tx.commerceOrder.findUnique({ where: { id: orderId }, include: orderInclude });
      if (!order) throw new NotFoundException('Historical order not found.');
      const blocked = (code: string) => ({ orderId, status: 'blocked' as const, readOnly: true as const,
        purchasedAccessPreserved: true as const, findings: [{ code }], scope: 'single_order' as const });
      if (order.lines.length !== 1 || order.lines[0].productType !== 'membership') return blocked('NOT_A_SINGLE_MEMBERSHIP_ORDER');
      const line = order.lines[0]; const intent = order.membershipCheckoutIntent;
      if (!intent || intent.userId !== order.buyerId || intent.orderId !== order.id || intent.versionId !== line.productReferenceId
        || line.quantity !== 1 || line.currency !== order.currency || line.finalAmountMinor !== order.payableAmountMinor) return blocked('PURCHASE_SNAPSHOT_MISMATCH');
      if (order.status !== 'confirmed' || order.fulfillmentStatus !== 'fulfilled') return blocked('ORDER_NOT_FULFILLED');
      if (order.refunds.length) return blocked('REFUND_REQUIRES_REVIEW');
      if (!gatewayProofMatches(order) && !await walletProofMatches(tx, order)) return blocked('SOURCE_NOT_VERIFIED');
      if (intent.version.includedCourses.length > COMPONENT_LIMIT || intent.version.serviceEntitlements.length > COMPONENT_LIMIT
        || intent.removedCourses.length > COMPONENT_LIMIT || order.fulfillmentEffects.length > HISTORY_LIMIT) return blocked('RECONCILIATION_LIMIT_EXCEEDED');
      if (order.fulfillmentEffects.some(effect => effect.orderId !== order.id || effect.orderLineId !== line.id)) return blocked('FULFILLMENT_EFFECT_SOURCE_MISMATCH');
      if (intent.removedCourses.some(course => Boolean(course.graceStartsAt) !== Boolean(course.graceEndsAt))) return blocked('INVALID_GRACE_SNAPSHOT');

      const [subscription, courseGrants, serviceGrants] = await Promise.all([
        tx.membershipSubscription.findUnique({ where: { sourceOrderLineId: line.id } }),
        tx.courseAccessGrant.findMany({ where: { sourceType: { in: ['membership', 'membership_grace'] },
          OR: [{ sourceId: line.id }, { sourceId: { startsWith: `${line.id}:` } }] }, orderBy: { id: 'asc' }, take: HISTORY_LIMIT + 1 }),
        tx.serviceEntitlementGrant.findMany({ where: { sourceType: 'membership', sourceId: line.id }, orderBy: { id: 'asc' }, take: HISTORY_LIMIT + 1 }),
      ]);
      if (courseGrants.length > HISTORY_LIMIT || serviceGrants.length > HISTORY_LIMIT) return blocked('RECONCILIATION_LIMIT_EXCEEDED');
      const usage = serviceGrants.length ? await tx.serviceEntitlementUsage.findMany({ where: { grantId: { in: serviceGrants.map(grant => grant.id) } },
        select: { grantId: true, userId: true, quantity: true, periodStartsAt: true, periodEndsAt: true },
        orderBy: { id: 'asc' }, take: HISTORY_LIMIT + 1 }) : [];
      if (usage.length > HISTORY_LIMIT) return blocked('RECONCILIATION_LIMIT_EXCEEDED');
      const courses = [
        ...intent.version.includedCourses.map(course => ({ courseId: course.courseId, sourceType: 'membership', sourceId: line.id, startsAt: intent.startsAt, endsAt: intent.endsAt })),
        ...intent.removedCourses.filter(course => course.graceStartsAt && course.graceEndsAt).map(course => ({ courseId: course.courseId,
          sourceType: 'membership_grace', sourceId: `${line.id}:${course.courseId}`, startsAt: course.graceStartsAt!, endsAt: course.graceEndsAt! })),
      ];
      return { ...reconcileLegacyMembership({ orderId, buyerId: order.buyerId, lineId: line.id, versionId: intent.versionId,
        sourceVerified: true, startsAt: intent.startsAt, endsAt: intent.endsAt, subscription, courses,
        services: intent.version.serviceEntitlements, courseGrants, serviceGrants, usage, effects: order.fulfillmentEffects }), scope: 'single_order' as const };
    }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
  }
}
