import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CommerceIdempotencyStatus,
  CommerceOrderStatus,
  CommerceProductType,
  MembershipCheckoutAction,
  MembershipPlanStatus,
  MembershipPlanVersionStatus,
  MembershipSubscriptionStatus,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceProductService } from '../commerce/commerce-product.service';
import { CreateMembershipCheckoutDto } from './dto/membership-plan.dto';
import { calculateDurationPrice, resolveMembershipChange } from './membership.rules';

const CURRENCY = 'VND';
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/;

@Injectable()
export class MembershipCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly commerceProducts: CommerceProductService,
  ) {}

  async catalog() {
    const now = new Date();
    const versions = await this.prisma.membershipPlanVersion.findMany({
      where: {
        status: MembershipPlanVersionStatus.published,
        plan: { status: MembershipPlanStatus.active },
        AND: [{ OR: [{ salesStartAt: null }, { salesStartAt: { lte: now } }] }, { OR: [{ salesEndAt: null }, { salesEndAt: { gt: now } }] }],
      },
      orderBy: [{ plan: { code: 'asc' } }, { versionNumber: 'desc' }],
      include: {
        plan: { select: { id: true, code: true } },
        durationOptions: { orderBy: { displayOrder: 'asc' } },
        serviceEntitlements: { orderBy: { definition: { displayOrder: 'asc' } }, include: { definition: true } },
        includedCourses: { orderBy: { course: { title: 'asc' } }, include: { course: { select: { id: true, title: true, slug: true } } } },
      },
    });
    return { items: versions.map((version) => this.catalogItem(version)) };
  }

  async current(learnerId: string) {
    const now = new Date();
    const [subscription, pendingChange] = await Promise.all([
      this.prisma.membershipSubscription.findFirst({
        where: { userId: learnerId, status: MembershipSubscriptionStatus.active },
        orderBy: { expiresAt: 'desc' },
        include: { version: { include: { plan: { select: { id: true, code: true } } } } },
      }),
      this.prisma.membershipCheckoutIntent.findFirst({
        where: {
          userId: learnerId,
          action: { in: [MembershipCheckoutAction.upgrade, MembershipCheckoutAction.downgrade] },
          order: { status: CommerceOrderStatus.pending_payment },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { id: true, orderNumber: true, status: true } },
          version: { include: { plan: { select: { id: true, code: true } } } },
        },
      }),
    ]);
    return {
      membership: subscription ? {
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
    };
  }

  createCheckout(learnerId: string, idempotencyKey: string | undefined, input: CreateMembershipCheckoutDto) {
    if (!idempotencyKey || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-128 printable ASCII characters.' });
    }
    if (!input.changedBenefitsConfirmed) {
      throw new BadRequestException({ error: 'BENEFITS_CONFIRMATION_REQUIRED', message: 'Changed membership benefits must be explicitly confirmed.' });
    }
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    return this.runSerializable((tx) => this.createCheckoutTransaction(tx, learnerId, input, keyHash, requestHash));
  }

  private async createCheckoutTransaction(
    tx: Prisma.TransactionClient, learnerId: string, input: CreateMembershipCheckoutDto, keyHash: string, requestHash: string,
  ) {
    const existing = await tx.commerceIdempotencyRecord.findUnique({
      where: { actorId_operation_keyHashVersion_keyHash: { actorId: learnerId, operation: 'membership_checkout', keyHashVersion: 1, keyHash } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was reused with different input.' });
      if (existing.status !== CommerceIdempotencyStatus.completed || !existing.resourceId) throw new ConflictException({ error: 'REQUEST_IN_PROGRESS', message: 'Membership checkout is still processing.' });
      return this.checkoutResponse(tx, existing.resourceId);
    }
    const now = new Date();
    const idempotency = await tx.commerceIdempotencyRecord.create({
      data: { actorId: learnerId, operation: 'membership_checkout', keyHash, keyHashVersion: 1, requestHash, requestCanonicalizationVersion: 1, status: CommerceIdempotencyStatus.in_progress, lockedUntil: new Date(now.getTime() + 30_000) },
    });
    await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plan_versions WHERE id = ${input.versionId}::uuid FOR SHARE`);
    const version = await tx.membershipPlanVersion.findFirst({
      where: { id: input.versionId, status: MembershipPlanVersionStatus.published, plan: { status: MembershipPlanStatus.active } },
      include: { plan: true, durationOptions: true },
    });
    if (!version || (version.salesStartAt && version.salesStartAt > now) || (version.salesEndAt && version.salesEndAt <= now)) {
      throw new NotFoundException({ error: 'MEMBERSHIP_UNAVAILABLE', message: 'Membership version is not available.' });
    }
    const duration = version.durationOptions.find((item) => item.id === input.durationOptionId);
    if (!duration) throw new BadRequestException({ error: 'DURATION_UNAVAILABLE', message: 'Duration is not available for this membership version.' });
    const current = await tx.membershipSubscription.findFirst({
      where: { userId: learnerId, status: MembershipSubscriptionStatus.active }, orderBy: { expiresAt: 'desc' }, include: { version: true },
    });
    const hasActiveMembership = Boolean(current && current.expiresAt > now);
    const action: MembershipCheckoutAction = !current ? MembershipCheckoutAction.purchase
      : current.version.planId === version.planId ? MembershipCheckoutAction.renew
        : !hasActiveMembership ? MembershipCheckoutAction.purchase
          : input.requestedChange === 'DOWNGRADE' ? MembershipCheckoutAction.downgrade : MembershipCheckoutAction.upgrade;
    if (hasActiveMembership && current!.version.planId !== version.planId && !input.requestedChange) {
      throw new BadRequestException({ error: 'CHANGE_KIND_REQUIRED', message: 'An upgrade or downgrade must be selected explicitly.' });
    }
    const term = resolveMembershipChange({ action: action.toUpperCase() as 'PURCHASE' | 'RENEW' | 'UPGRADE' | 'DOWNGRADE', months: duration.months, paymentAt: now, activeExpiresAt: current?.expiresAt ?? null });
    const amount = calculateDurationPrice({ baseMonthlyPriceAmountMinor: version.baseMonthlyPriceAmountMinor, months: duration.months, priceAmountMinor: duration.priceAmountMinor, discountPercent: duration.discountPercent });
    const baseAmount = version.baseMonthlyPriceAmountMinor * BigInt(duration.months);
    const listAmount = duration.discountPercent === null ? amount : baseAmount;
    const discountAmount = listAmount - amount;
    const product = await this.commerceProducts.ensureActiveMembershipProduct(
      tx,
      version.id,
      version.publishedById!,
    );
    const orderId = randomUUID();
    const order = await tx.commerceOrder.create({ data: { id: orderId, orderNumber: `EDU-M-${now.getTime().toString(36).toUpperCase()}-${orderId.slice(0, 8).toUpperCase()}`, buyerId: learnerId, subtotalAmountMinor: listAmount, discountAmountMinor: discountAmount, payableAmountMinor: amount, currency: CURRENCY, pricingPolicyVersion: 'MEMBERSHIP_V1' } });
    await tx.membershipCheckoutIntent.create({ data: { orderId, userId: learnerId, versionId: version.id, durationOptionId: duration.id, action, startsAt: term.startsAt, endsAt: term.endsAt, activatesImmediately: term.activatesImmediately } });
    await tx.commerceOrderLine.create({ data: { orderId, productId: product.id, productType: CommerceProductType.membership, productReferenceId: version.id, sellerId: product.sellerId, displayTitle: version.displayName, unitListPriceAmountMinor: listAmount, subtotalAmountMinor: listAmount, discountAmountMinor: discountAmount, finalAmountMinor: amount, currency: CURRENCY } });
    await tx.commerceIdempotencyRecord.update({ where: { id: idempotency.id }, data: { status: CommerceIdempotencyStatus.completed, resourceType: 'commerce_order', resourceId: orderId, completedAt: now, lockedUntil: now } });
    await this.audit.record({ actorId: learnerId, action: AuditAction.MembershipCheckoutCreated, target: { type: 'membership_checkout_intent', id: orderId }, metadata: { orderNumber: order.orderNumber, versionId: version.id, durationMonths: duration.months, action, startsAt: term.startsAt.toISOString(), endsAt: term.endsAt.toISOString() } }, tx);
    return this.checkoutResponse(tx, orderId);
  }

  private async checkoutResponse(tx: Prisma.TransactionClient, orderId: string) {
    const intent = await tx.membershipCheckoutIntent.findUnique({ where: { orderId }, include: { order: true, version: { include: { plan: true } }, durationOption: true } });
    if (!intent) throw new NotFoundException('Membership checkout was not found.');
    return { order: { id: intent.order.id, orderNumber: intent.order.orderNumber, status: intent.order.status.toUpperCase(), payable: { amountMinor: intent.order.payableAmountMinor.toString(), currency: intent.order.currency } }, action: intent.action.toUpperCase(), plan: { id: intent.version.plan.id, code: intent.version.plan.code, versionId: intent.versionId, displayName: intent.version.displayName }, durationMonths: intent.durationOption.months, startsAt: intent.startsAt, endsAt: intent.endsAt, activatesImmediately: intent.activatesImmediately, paymentRequired: intent.order.payableAmountMinor > 0n };
  }

  private catalogItem(version: any) {
    return { id: version.id, plan: version.plan, versionNumber: version.versionNumber, displayName: version.displayName, description: version.description, currency: version.currency, baseMonthlyPriceAmountMinor: version.baseMonthlyPriceAmountMinor.toString(), durations: version.durationOptions.map((duration: any) => ({ id: duration.id, months: duration.months, basePriceAmountMinor: (version.baseMonthlyPriceAmountMinor * BigInt(duration.months)).toString(), discountPercent: duration.discountPercent, finalPriceAmountMinor: calculateDurationPrice({ baseMonthlyPriceAmountMinor: version.baseMonthlyPriceAmountMinor, months: duration.months, priceAmountMinor: duration.priceAmountMinor, discountPercent: duration.discountPercent }).toString() })), services: version.serviceEntitlements.map((item: any) => ({ code: item.definition.code, displayName: item.definition.displayName, valueType: item.valueType.toUpperCase(), booleanValue: item.booleanValue, quota: item.quota?.toString() ?? null, unitLabel: item.definition.unitLabel })), includedCourses: version.includedCourses.map((item: any) => ({ ...item.course, graceDays: item.graceDays })) };
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || (error.code !== 'P2034' && error.code !== 'P2002') || attempt === 2) throw error; }
    throw new Error('Unreachable transaction retry state.');
  }
}
