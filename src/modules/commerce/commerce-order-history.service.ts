import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListOrdersQueryDto,
  OrderHistoryItemResponseDto,
  OrderHistoryPageResponseDto,
} from './dto/order-history.dto';

const historyInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  paymentAttempts: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.CommerceOrderInclude;

type HistoryOrder = Prisma.CommerceOrderGetPayload<{ include: typeof historyInclude }>;

@Injectable()
export class CommerceOrderHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    learnerId: string,
    query: ListOrdersQueryDto = { page: 1, pageSize: 20 },
  ): Promise<OrderHistoryPageResponseDto> {
    const where: Prisma.CommerceOrderWhereInput = {
      buyerId: learnerId,
      archivedAt: null,
    };
    const [total, orders] = await Promise.all([
      this.prisma.commerceOrder.count({ where }),
      this.prisma.commerceOrder.findMany({
        where,
        include: historyInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: orders.map((order) => this.project(order)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(learnerId: string, orderId: string): Promise<OrderHistoryItemResponseDto> {
    const order = await this.prisma.commerceOrder.findFirst({
      where: { id: orderId, buyerId: learnerId, archivedAt: null },
      include: historyInclude,
    });
    if (!order) throw new NotFoundException('Order was not found.');
    return this.project(order);
  }

  private project(order: HistoryOrder): OrderHistoryItemResponseDto {
    const money = (amount: bigint) => ({
      amountMinor: amount.toString(),
      currency: order.currency,
    });
    const payment = order.paymentAttempts[0] ?? null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status.toUpperCase(),
      fulfillmentStatus: order.fulfillmentStatus.toUpperCase(),
      subtotal: money(order.subtotalAmountMinor),
      discount: money(order.discountAmountMinor),
      payable: money(order.payableAmountMinor),
      paymentRequired: order.payableAmountMinor > 0n,
      lines: order.lines.map((line) => ({
        id: line.id,
        productType: line.productType.toUpperCase(),
        productReferenceId: line.productReferenceId,
        title: line.displayTitle,
        quantity: line.quantity,
        unitListPrice: money(line.unitListPriceAmountMinor),
        finalPrice: money(line.finalAmountMinor),
      })),
      payment: payment
        ? {
            id: payment.id,
            status: payment.status.toUpperCase(),
            amount: money(payment.amountMinor),
            expiresAt: payment.providerExpiresAt,
            createdAt: payment.createdAt,
          }
        : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      confirmedAt: order.confirmedAt,
      cancelledAt: order.cancelledAt,
      expiredAt: order.expiredAt,
    };
  }
}
