import { Injectable } from '@nestjs/common';
import { CommerceOrderStatus, MembershipSubscriptionStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipContinuityService } from './membership-continuity.service';

@Injectable()
export class MembershipCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly continuity: MembershipContinuityService,
  ) {}

  async current(learnerId: string) {
    const now = new Date();
    const [subscription, pendingChange, expiringGraceCourses] = await Promise.all([
      this.prisma.membershipSubscription.findFirst({
        where: {
          userId: learnerId,
          status: MembershipSubscriptionStatus.active,
          startsAt: { lte: now },
        },
        orderBy: { expiresAt: 'desc' },
        include: { version: { include: { plan: { select: { id: true, code: true } } } } },
      }),
      this.prisma.membershipCheckoutIntent.findFirst({
        where: {
          userId: learnerId,
          order: { status: CommerceOrderStatus.pending_payment },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { id: true, orderNumber: true, status: true } },
          version: { include: { plan: { select: { id: true, code: true } } } },
        },
      }),
      this.continuity.listExpiringGrace(learnerId, now),
    ]);
    const receiptEffect = subscription?.sourceOrderLineId === null
      ? await this.prisma.commerceReceiptAccessEffect.findFirst({
        where: { resourceType: 'membership_subscription', resourceId: subscription.id, effectKind: 'MEMBERSHIP_TERM',
          generation: { buyerId: learnerId, status: 'ACCESS_UNVERIFIED' } },
        select: { generation: { select: { status: true, orderId: true, generation: true } } },
      }) : null;
    return {
      membership: subscription ? {
        ...(receiptEffect ? { source: 'UNVERIFIED_RECEIPT_ACCESS', verificationStatus: 'PENDING_RECONCILIATION',
          financialProof: false, sourceOrderId: receiptEffect.generation.orderId } : {}),
        id: subscription.id,
        plan: subscription.version.plan,
        versionId: subscription.versionId,
        displayName: subscription.version.displayName,
        startsAt: subscription.startsAt,
        expiresAt: subscription.expiresAt,
        status: subscription.expiresAt > now ? 'ACTIVE' : 'EXPIRED',
      } : null,
      pendingChange: pendingChange ? {
        action: pendingChange.action.toUpperCase(),
        startsAt: pendingChange.startsAt,
        endsAt: pendingChange.endsAt,
        activatesImmediately: pendingChange.activatesImmediately,
        plan: {
          id: pendingChange.version.plan.id,
          code: pendingChange.version.plan.code,
          versionId: pendingChange.version.id,
          displayName: pendingChange.version.displayName,
        },
        order: {
          id: pendingChange.order.id,
          orderNumber: pendingChange.order.orderNumber,
          status: pendingChange.order.status.toUpperCase(),
        },
      } : null,
      expiringGraceCourses,
    };
  }

}
