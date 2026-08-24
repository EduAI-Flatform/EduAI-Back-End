import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommerceProductStatus,
  CommerceProductType,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CoursesService } from '../courses/courses.service';
import {
  ListCommerceCatalogQueryDto,
  ListCommerceOrdersQueryDto,
  UpdateCommerceCatalogDto,
} from './dto/admin-commerce.dto';

const orderListSelect = {
  id: true,
  orderNumber: true,
  status: true,
  fulfillmentStatus: true,
  subtotalAmountMinor: true,
  discountAmountMinor: true,
  payableAmountMinor: true,
  currency: true,
  pricingPolicyVersion: true,
  createdAt: true,
  confirmedAt: true,
  buyer: { select: { id: true, email: true, fullName: true } },
  paymentAttempts: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true },
  },
  _count: { select: { lines: true } },
} satisfies Prisma.CommerceOrderSelect;

const orderDetailSelect = {
  ...orderListSelect,
  lines: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      productType: true,
      productReferenceId: true,
      sellerId: true,
      displayTitle: true,
      quantity: true,
      unitListPriceAmountMinor: true,
      subtotalAmountMinor: true,
      discountAmountMinor: true,
      finalAmountMinor: true,
      currency: true,
      benefits: {
        select: {
          benefitType: true,
          sourceId: true,
          policyVersion: true,
          sourceVersion: true,
          allocatedDiscountAmountMinor: true,
        },
      },
    },
  },
  paymentAttempts: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      status: true,
      amountMinor: true,
      currency: true,
      providerStatusCheckedAt: true,
      createdAt: true,
      paidAt: true,
      closedAt: true,
    },
  },
  settlements: {
    orderBy: { recordedAt: 'desc' as const },
    select: {
      id: true,
      kind: true,
      disposition: true,
      amountMinor: true,
      currency: true,
      settledAt: true,
      recordedAt: true,
    },
  },
} satisfies Prisma.CommerceOrderSelect;

type OrderListRecord = Prisma.CommerceOrderGetPayload<{ select: typeof orderListSelect }>;
type OrderDetailRecord = Prisma.CommerceOrderGetPayload<{ select: typeof orderDetailSelect }>;

@Injectable()
export class CommerceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coursesService: CoursesService,
    private readonly auditService: AuditService,
  ) {}

  async listCatalog(query: ListCommerceCatalogQueryDto) {
    const page = await this.coursesService.listCommerceCatalog(query);
    return {
      ...page,
      items: page.items.map((course) => ({
        id: course.id,
        title: course.title,
        slug: course.slug,
        priceAmountMinor:
          course.priceAmountMinor === null ? null : String(course.priceAmountMinor),
        priceCurrency: course.priceCurrency,
        status: course.status.toUpperCase(),
        visibility: course.visibility.toUpperCase(),
        moderationStatus: course.moderationStatus.toUpperCase(),
        updatedAt: course.updatedAt,
        instructor: course.instructor,
        product: course.commerceProduct
          ? {
              id: course.commerceProduct.id,
              status: course.commerceProduct.status.toUpperCase(),
              archivedAt: course.commerceProduct.archivedAt,
            }
          : null,
      })),
    };
  }

  updateCatalog(
    actorId: string,
    courseId: string,
    input: UpdateCommerceCatalogDto,
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM courses WHERE id = ${courseId}::uuid FOR UPDATE`,
      );
      const current = await tx.course.findUnique({
        where: { id: courseId },
        select: {
          id: true,
          instructorId: true,
          status: true,
          visibility: true,
          moderationStatus: true,
          deletedAt: true,
          updatedAt: true,
        },
      });
      if (!current || current.deletedAt) throw new NotFoundException('Course not found.');
      if (current.updatedAt.getTime() !== new Date(input.expectedCourseUpdatedAt).getTime()) {
        throw new ConflictException({
          error: 'CATALOG_VERSION_CONFLICT',
          message: 'Course catalog changed. Reload before saving.',
        });
      }
      if (
        input.sellable &&
        (input.priceAmountMinor <= 0 ||
          current.status !== 'published' ||
          current.visibility !== 'public' ||
          current.moderationStatus !== 'clear')
      ) {
        throw new BadRequestException({
          error: 'COURSE_NOT_SELLABLE',
          message: 'A sellable course must be published, public, moderation-clear, and paid.',
        });
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_products WHERE course_id = ${courseId}::uuid FOR UPDATE`,
      );
      let product = await tx.commerceProduct.findUnique({ where: { courseId } });
      const previousStatus = product?.status ?? 'none';
      if (input.sellable && product?.status === CommerceProductStatus.archived) {
        throw new ConflictException({
          error: 'PRODUCT_ARCHIVED',
          message: 'Archived product identity cannot be reactivated.',
        });
      }

      const updatedCourse = await this.coursesService.updateCommercePrice(
        tx,
        actorId,
        courseId,
        { priceAmountMinor: input.priceAmountMinor, priceCurrency: input.priceCurrency },
      );
      if (input.sellable) {
        if (!product) {
          product = await tx.commerceProduct.create({
            data: {
              type: CommerceProductType.course,
              courseId,
              sellerId: current.instructorId,
              status: CommerceProductStatus.draft,
            },
          });
        }
        if (product.status === CommerceProductStatus.draft) {
          product = await tx.commerceProduct.update({
            where: { id: product.id },
            data: { status: CommerceProductStatus.active },
          });
        }
      } else if (product?.status === CommerceProductStatus.active) {
        product = await tx.commerceProduct.update({
          where: { id: product.id },
          data: { status: CommerceProductStatus.archived, archivedAt: new Date() },
        });
      }

      if ((product?.status ?? 'none') !== previousStatus) {
        await this.auditService.record(
          {
            actorId,
            action: AuditAction.CommerceProductStatusChanged,
            target: { type: 'commerce_product', id: product!.id },
            metadata: {
              courseId,
              previousStatus,
              nextStatus: product!.status,
              operationId: randomUUID(),
            },
          },
          tx,
        );
      }
      return {
        id: updatedCourse.id,
        title: updatedCourse.title,
        slug: updatedCourse.slug,
        priceAmountMinor: String(updatedCourse.priceAmountMinor ?? 0),
        priceCurrency: updatedCourse.priceCurrency,
        status: updatedCourse.status.toUpperCase(),
        visibility: updatedCourse.visibility.toUpperCase(),
        moderationStatus: updatedCourse.moderationStatus.toUpperCase(),
        updatedAt: updatedCourse.updatedAt,
        instructor: updatedCourse.instructor,
        product: product
          ? { id: product.id, status: product.status.toUpperCase(), archivedAt: product.archivedAt }
          : null,
      };
    });
  }

  async listOrders(query: ListCommerceOrdersQueryDto) {
    const where = this.orderWhere(query);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.commerceOrder.count({ where }),
      this.prisma.commerceOrder.findMany({
        where,
        select: orderListSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: items.map((order) => this.toOrderList(order)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async getOrder(orderId: string) {
    const [order, lifecycle] = await Promise.all([
      this.prisma.commerceOrder.findUnique({
        where: { id: orderId },
        select: orderDetailSelect,
      }),
      this.prisma.commerceLifecycleEvent.findMany({
        where: { entityType: 'order', entityId: orderId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          previousStatus: true,
          nextStatus: true,
          actorKind: true,
          reasonCode: true,
          occurredAt: true,
          actor: { select: { id: true, email: true, fullName: true } },
        },
      }),
    ]);
    if (!order) throw new NotFoundException('Order not found.');
    return {
      ...this.toOrderList(order),
      lines: order.lines.map((line) => ({
        id: line.id,
        productType: line.productType.toUpperCase(),
        productReferenceId: line.productReferenceId,
        sellerId: line.sellerId,
        displayTitle: line.displayTitle,
        quantity: line.quantity,
        unitListPriceAmountMinor: line.unitListPriceAmountMinor.toString(),
        subtotalAmountMinor: line.subtotalAmountMinor.toString(),
        discountAmountMinor: line.discountAmountMinor.toString(),
        finalAmountMinor: line.finalAmountMinor.toString(),
        currency: line.currency,
        benefits: line.benefits.map((benefit) => ({
          type: benefit.benefitType.toUpperCase(),
          sourceId: benefit.sourceId,
          policyVersion: benefit.policyVersion,
          sourceVersion: benefit.sourceVersion,
          allocatedDiscountAmountMinor: benefit.allocatedDiscountAmountMinor.toString(),
        })),
      })),
      paymentAttempts: order.paymentAttempts.map((attempt) => ({
        id: attempt.id,
        status: attempt.status.toUpperCase(),
        amountMinor: attempt.amountMinor.toString(),
        currency: attempt.currency,
        providerStatusCheckedAt: attempt.providerStatusCheckedAt,
        createdAt: attempt.createdAt,
        paidAt: attempt.paidAt,
        closedAt: attempt.closedAt,
      })),
      settlements: order.settlements.map((settlement) => ({
        id: settlement.id,
        kind: settlement.kind.toUpperCase(),
        disposition: settlement.disposition.toUpperCase(),
        amountMinor: settlement.amountMinor.toString(),
        currency: settlement.currency,
        settledAt: settlement.settledAt,
        recordedAt: settlement.recordedAt,
      })),
      lifecycle: lifecycle.map((event) => ({
        ...event,
        actorKind: event.actorKind.toUpperCase(),
      })),
    };
  }

  private orderWhere(query: ListCommerceOrdersQueryDto): Prisma.CommerceOrderWhereInput {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.fulfillmentStatus ? { fulfillmentStatus: query.fulfillmentStatus } : {}),
      ...(query.search
        ? {
            OR: [
              { orderNumber: { contains: query.search, mode: 'insensitive' } },
              { buyer: { email: { contains: query.search, mode: 'insensitive' } } },
              { buyer: { fullName: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private toOrderList(order: OrderListRecord | OrderDetailRecord) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status.toUpperCase(),
      fulfillmentStatus: order.fulfillmentStatus.toUpperCase(),
      subtotalAmountMinor: order.subtotalAmountMinor.toString(),
      discountAmountMinor: order.discountAmountMinor.toString(),
      payableAmountMinor: order.payableAmountMinor.toString(),
      currency: order.currency,
      pricingPolicyVersion: order.pricingPolicyVersion,
      createdAt: order.createdAt,
      confirmedAt: order.confirmedAt,
      buyer: order.buyer,
      lineCount: order._count.lines,
      paymentStatus: order.paymentAttempts[0]?.status.toUpperCase() ?? 'NOT_CREATED',
    };
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2034' ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw new Error('Unreachable Commerce admin retry state.');
  }
}
