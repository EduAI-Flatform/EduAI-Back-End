import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CommerceActorKind,
  CommerceBenefitType,
  CommerceCartStatus,
  CommerceFulfillmentStatus,
  CommerceIdempotencyStatus,
  CommerceLifecycleEntityType,
  CommerceOrderStatus,
  CommerceProductStatus,
  CommerceReservationStatus,
  CommerceSettlementDisposition,
  CommerceSettlementKind,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { CourseAccessService } from '../access/course-access.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';

const CURRENCY = 'VND';
const IDEMPOTENCY_OPERATION = 'commerce.create-order';
const PRICING_POLICY_VERSION = 'course-v1-single-promotion';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const orderInclude = {
  lines: {
    orderBy: { createdAt: 'asc' as const },
    include: { benefits: { orderBy: { createdAt: 'asc' as const } } },
  },
} satisfies Prisma.CommerceOrderInclude;

const checkoutCartInclude = {
  lines: {
    orderBy: { createdAt: 'asc' as const },
    include: { product: { include: { course: true } } },
  },
} satisfies Prisma.CommerceCartInclude;

type OrderRecord = Prisma.CommerceOrderGetPayload<{ include: typeof orderInclude }>;
type CheckoutCart = Prisma.CommerceCartGetPayload<{ include: typeof checkoutCartInclude }>;

interface PricedLine {
  id: string;
  productId: string;
  courseId: string;
  sellerId: string;
  title: string;
  listPrice: bigint;
  discount: bigint;
  finalPrice: bigint;
  voucher?: { id: string; sourceVersion: string };
}

@Injectable()
export class CommerceOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly vouchersService: VouchersService,
    private readonly auditService: AuditService,
    private readonly courseAccess: CourseAccessService,
  ) {}

  createOrder(
    learnerId: string,
    idempotencyKey: string | undefined,
    input: CreateOrderDto,
  ): Promise<OrderResponseDto> {
    this.assertConfigured();
    this.assertIdempotencyKey(idempotencyKey);
    const normalizedApplications = this.normalizeApplications(input);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ voucherApplications: normalizedApplications }))
      .digest('hex');
    const keyHash = createHmac(
      'sha256',
      this.config.commerce.idempotencySecret as string,
    )
      .update(idempotencyKey)
      .digest('hex');

    return this.runSerializable((tx) =>
      this.createOrderTransaction(tx, learnerId, keyHash, requestHash, normalizedApplications),
    );
  }

  private async createOrderTransaction(
    tx: Prisma.TransactionClient,
    learnerId: string,
    keyHash: string,
    requestHash: string,
    applications: Array<{ courseId: string; code: string }>,
  ): Promise<OrderResponseDto> {
    const existing = await tx.commerceIdempotencyRecord.findUnique({
      where: {
        actorId_operation_keyHashVersion_keyHash: {
          actorId: learnerId,
          operation: IDEMPOTENCY_OPERATION,
          keyHashVersion: 1,
          keyHash,
        },
      },
    });
    if (existing) return this.resolveExisting(tx, existing, requestHash);

    const operationId = randomUUID();
    const now = new Date();
    const idempotency = await tx.commerceIdempotencyRecord.create({
      data: {
        actorId: learnerId,
        operation: IDEMPOTENCY_OPERATION,
        keyHash,
        keyHashVersion: 1,
        requestHash,
        requestCanonicalizationVersion: 1,
        status: CommerceIdempotencyStatus.in_progress,
        lockedUntil: new Date(now.getTime() + 30_000),
      },
    });

    const cart = await tx.commerceCart.findFirst({
      where: { buyerId: learnerId, status: CommerceCartStatus.active },
      include: checkoutCartInclude,
    });
    if (!cart || cart.lines.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_CART', message: 'Cart is empty.' });
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_carts WHERE id = ${cart.id}::uuid FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM courses WHERE id IN (${Prisma.join(
        cart.lines.map((line) => line.product.courseId as string),
      )}) FOR SHARE`,
    );

    const owned = await Promise.all(cart.lines.map((line) =>
      this.courseAccess.decideWithClient({
        user: { id: learnerId, roles: [RoleName.student] },
        courseId: line.product.courseId as string,
        operation: 'FULL_LEARNING',
      }, tx),
    ));
    if (owned.some((decision) => decision.allowed)) {
      throw new ConflictException({
        error: 'ALREADY_OWNED',
        message: 'One or more cart courses are already owned.',
      });
    }

    const applicationByCourse = new Map(applications.map((item) => [item.courseId, item.code]));
    const cartCourseIds = new Set(cart.lines.map((line) => line.product.courseId));
    if (applications.some((item) => !cartCourseIds.has(item.courseId))) {
      throw new BadRequestException({
        error: 'VOUCHER_TARGET_NOT_IN_CART',
        message: 'A voucher target is not present in the active cart.',
      });
    }
    const pricedLines = await this.priceLines(tx, learnerId, cart, applicationByCourse);
    const subtotal = pricedLines.reduce((sum, line) => sum + line.listPrice, 0n);
    const discount = pricedLines.reduce((sum, line) => sum + line.discount, 0n);
    const payable = subtotal - discount;
    const orderId = randomUUID();
    const order = await tx.commerceOrder.create({
      data: {
        id: orderId,
        orderNumber: this.createOrderNumber(now),
        cartId: cart.id,
        buyerId: learnerId,
        subtotalAmountMinor: subtotal,
        discountAmountMinor: discount,
        payableAmountMinor: payable,
        currency: CURRENCY,
        pricingPolicyVersion: PRICING_POLICY_VERSION,
      },
    });

    const reservationUsages: Array<{
      reservationId: string;
      voucherId: string;
      courseId: string;
      originalAmountMinor: number;
      discountAmountMinor: number;
      finalAmountMinor: number;
    }> = [];
    for (const line of pricedLines) {
      const orderLineId = randomUUID();
      await tx.commerceOrderLine.create({
        data: {
          id: orderLineId,
          orderId,
          productId: line.productId,
          productType: 'course',
          productReferenceId: line.courseId,
          sellerId: line.sellerId,
          displayTitle: line.title,
          quantity: 1,
          unitListPriceAmountMinor: line.listPrice,
          subtotalAmountMinor: line.listPrice,
          discountAmountMinor: line.discount,
          finalAmountMinor: line.finalPrice,
          currency: CURRENCY,
        },
      });
      if (line.voucher) {
        const reservationId = randomUUID();
        reservationUsages.push({
          reservationId,
          voucherId: line.voucher.id,
          courseId: line.courseId,
          originalAmountMinor: Number(line.listPrice),
          discountAmountMinor: Number(line.discount),
          finalAmountMinor: Number(line.finalPrice),
        });
        await tx.commercePromotionReservation.create({
          data: {
            id: reservationId,
            buyerId: learnerId,
            orderId,
            orderLineId,
            benefitType: CommerceBenefitType.voucher,
            voucherId: line.voucher.id,
            status: CommerceReservationStatus.reserved,
            reservedAt: now,
            expiresAt: new Date(now.getTime() + 15 * 60_000),
          },
        });
        await tx.commerceOrderLineBenefit.create({
          data: {
            orderLineId,
            benefitType: CommerceBenefitType.voucher,
            sourceId: line.voucher.id,
            policyVersion: PRICING_POLICY_VERSION,
            sourceVersion: line.voucher.sourceVersion,
            allocatedDiscountAmountMinor: line.discount,
            reservationId,
          },
        });
      }
    }

    await tx.commerceCart.update({
      where: { id: cart.id },
      data: { status: CommerceCartStatus.converted, convertedAt: now },
    });
    if (payable === 0n) {
      await this.confirmZeroPayableOrder(
        tx,
        learnerId,
        orderId,
        operationId,
        reservationUsages,
        now,
      );
    }
    await tx.commerceIdempotencyRecord.update({
      where: { id: idempotency.id },
      data: {
        status: CommerceIdempotencyStatus.completed,
        resourceType: 'commerce_order',
        resourceId: orderId,
        completedAt: now,
        lockedUntil: now,
      },
    });
    await this.auditService.record(
      {
        actorId: learnerId,
        action: AuditAction.CommerceOrderCreated,
        target: { type: 'commerce_order', id: orderId },
        metadata: {
          operationId,
          cartId: cart.id,
          orderNumber: order.orderNumber,
          subtotalAmountMinor: subtotal.toString(),
          discountAmountMinor: discount.toString(),
          payableAmountMinor: payable.toString(),
          currency: CURRENCY,
          pricingPolicyVersion: PRICING_POLICY_VERSION,
        },
      },
      tx,
    );
    return this.requireOrder(tx, orderId);
  }

  private async priceLines(
    tx: Prisma.TransactionClient,
    learnerId: string,
    cart: CheckoutCart,
    applications: Map<string, string>,
  ): Promise<PricedLine[]> {
    const priced: PricedLine[] = [];
    for (const line of cart.lines) {
      const course = line.product.course;
      if (
        line.product.status !== CommerceProductStatus.active ||
        !course ||
        course.deletedAt ||
        course.status !== 'published' ||
        course.visibility !== 'public' ||
        course.moderationStatus !== 'clear'
      ) {
        throw new BadRequestException({
          error: 'STALE_CART',
          message: 'A cart course is no longer available.',
        });
      }
      if (
        course.priceAmountMinor === null ||
        course.priceAmountMinor <= 0 ||
        !Number.isSafeInteger(course.priceAmountMinor)
      ) {
        throw new BadRequestException({
          error: 'STALE_CART',
          message: 'A cart price is no longer eligible for paid checkout.',
        });
      }
      if (course.priceCurrency !== CURRENCY || cart.currency !== CURRENCY) {
        throw new BadRequestException({
          error: 'UNSUPPORTED_CURRENCY',
          message: 'Phase 3 checkout supports VND only.',
        });
      }
      const voucherCode = applications.get(course.id);
      const voucher = voucherCode
        ? await this.vouchersService.evaluateForCommerce(tx, {
            userId: learnerId,
            courseId: course.id,
            categorySlug: course.categorySlug,
            code: voucherCode,
            priceAmountMinor: course.priceAmountMinor,
            currency: course.priceCurrency,
          })
        : undefined;
      const listPrice = BigInt(course.priceAmountMinor);
      const discount = BigInt(voucher?.discountAmountMinor ?? 0);
      priced.push({
        id: line.id,
        productId: line.productId,
        courseId: course.id,
        sellerId: line.product.sellerId,
        title: course.title,
        listPrice,
        discount,
        finalPrice: listPrice - discount,
        voucher: voucher ? { id: voucher.voucherId, sourceVersion: voucher.sourceVersion } : undefined,
      });
    }
    return priced;
  }

  private async confirmZeroPayableOrder(
    tx: Prisma.TransactionClient,
    learnerId: string,
    orderId: string,
    operationId: string,
    reservationUsages: Array<{
      reservationId: string;
      voucherId: string;
      courseId: string;
      originalAmountMinor: number;
      discountAmountMinor: number;
      finalAmountMinor: number;
    }>,
    now: Date,
  ): Promise<void> {
    const settlement = await tx.commerceSettlement.create({
      data: {
        orderId,
        kind: CommerceSettlementKind.no_payment_required,
        disposition: CommerceSettlementDisposition.internal,
        amountMinor: 0n,
        currency: CURRENCY,
        settledAt: now,
      },
    });
    await tx.commerceOrder.update({
      where: { id: orderId },
      data: {
        status: CommerceOrderStatus.confirmed,
        statusOperationId: operationId,
        confirmedSettlementId: settlement.id,
        confirmedAt: now,
      },
    });
    await tx.commerceLifecycleEvent.create({
      data: {
        entityType: CommerceLifecycleEntityType.order,
        entityId: orderId,
        previousStatus: CommerceOrderStatus.pending_payment,
        nextStatus: CommerceOrderStatus.confirmed,
        actorKind: CommerceActorKind.user,
        actorId: learnerId,
        operationId,
        reasonCode: 'NO_PAYMENT_REQUIRED',
      },
    });
    for (const usage of reservationUsages) {
      const reservationOperationId = randomUUID();
      await tx.commercePromotionReservation.update({
        where: { id: usage.reservationId },
        data: {
          status: CommerceReservationStatus.consumed,
          statusOperationId: reservationOperationId,
          consumedAt: now,
        },
      });
      await tx.commerceLifecycleEvent.create({
        data: {
          entityType: CommerceLifecycleEntityType.reservation,
          entityId: usage.reservationId,
          previousStatus: CommerceReservationStatus.reserved,
          nextStatus: CommerceReservationStatus.consumed,
          actorKind: CommerceActorKind.user,
          actorId: learnerId,
          operationId: reservationOperationId,
          reasonCode: 'ORDER_CONFIRMED',
        },
      });
      await tx.voucherRedemption.create({
        data: {
          voucherId: usage.voucherId,
          userId: learnerId,
          courseId: usage.courseId,
          redemptionKey: reservationOperationId,
          originalAmountMinor: usage.originalAmountMinor,
          discountAmountMinor: usage.discountAmountMinor,
          finalAmountMinor: usage.finalAmountMinor,
          currency: CURRENCY,
        },
      });
      await tx.voucher.update({
        where: { id: usage.voucherId },
        data: { redeemedCount: { increment: 1 } },
      });
    }
  }

  private async resolveExisting(
    tx: Prisma.TransactionClient,
    existing: Awaited<ReturnType<Prisma.TransactionClient['commerceIdempotencyRecord']['findUnique']>> & {},
    requestHash: string,
  ): Promise<OrderResponseDto> {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException({
        error: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was reused with different input.',
      });
    }
    if (existing.status !== CommerceIdempotencyStatus.completed || !existing.resourceId) {
      throw new ConflictException({
        error: 'REQUEST_IN_PROGRESS',
        message: 'The original request is still being processed.',
      });
    }
    return this.requireOrder(tx, existing.resourceId);
  }

  private async requireOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<OrderResponseDto> {
    const order = await tx.commerceOrder.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });
    if (!order) throw new InternalServerErrorException('Order result is unavailable.');
    return this.toResponse(order);
  }

  private toResponse(order: OrderRecord): OrderResponseDto {
    const money = (amount: bigint) => ({ amountMinor: amount.toString(), currency: order.currency });
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status.toUpperCase(),
      fulfillmentStatus: order.fulfillmentStatus.toUpperCase(),
      subtotal: money(order.subtotalAmountMinor),
      discount: money(order.discountAmountMinor),
      payable: money(order.payableAmountMinor),
      pricingPolicyVersion: order.pricingPolicyVersion,
      lines: order.lines.map((line) => ({
        id: line.id,
        courseId: line.productReferenceId,
        title: line.displayTitle,
        unitListPrice: money(line.unitListPriceAmountMinor),
        finalPrice: money(line.finalAmountMinor),
        benefits: line.benefits.map((benefit) => ({
          type: 'VOUCHER',
          sourceId: benefit.sourceId,
          discount: money(benefit.allocatedDiscountAmountMinor),
        })),
      })),
    };
  }

  private normalizeApplications(input: CreateOrderDto): Array<{ courseId: string; code: string }> {
    const applications = (input.voucherApplications ?? []).map((item) => ({
      courseId: item.courseId,
      code: item.code.trim().toUpperCase(),
    }));
    if (new Set(applications.map((item) => item.courseId)).size !== applications.length) {
      throw new BadRequestException({
        error: 'DUPLICATE_PROMOTION',
        message: 'At most one monetary promotion may be applied to a course line.',
      });
    }
    return applications.sort((left, right) => left.courseId.localeCompare(right.courseId));
  }

  private assertConfigured(): void {
    if (!this.config.commerce.idempotencySecret) {
      throw new ServiceUnavailableException({
        error: 'COMMERCE_CONFIGURATION_INVALID',
        message: 'Commerce is not configured safely.',
      });
    }
  }

  private assertIdempotencyKey(key: string | undefined): asserts key is string {
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be 8-128 bounded ASCII characters.',
      });
    }
  }

  private createOrderNumber(now: Date): string {
    return `EDU-${now.getTime().toString(36).toUpperCase()}-${randomUUID()
      .slice(0, 8)
      .toUpperCase()}`;
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable || attempt === 2) throw error;
      }
    }
    throw new Error('Unreachable commerce transaction retry state.');
  }
}
