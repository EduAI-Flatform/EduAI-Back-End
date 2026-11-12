import { Prisma } from '../../../generated/prisma/client';
export const affiliateOrderSelect = {
  id: true, status: true, fulfillmentStatus: true, currency: true, payableAmountMinor: true, confirmedSettlementId: true,
  confirmedSettlement: { select: { id: true, orderId: true, amountMinor: true, currency: true, settledAt: true, kind: true, disposition: true } },
  refunds: { where: { status: 'recorded' as const }, select: { id: true, settlementId: true, currency: true, status: true, amountMinor: true, recordedAt: true } },
} satisfies Prisma.CommerceOrderSelect;
