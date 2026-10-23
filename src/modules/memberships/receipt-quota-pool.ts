import { ConflictException } from '@nestjs/common';
import { Prisma, ServiceEntitlementResetPeriod, ServiceEntitlementValueType } from '../../../generated/prisma/client';

export interface ReceiptQuotaPoolInput {
  orderLineId: string;
  userId: string;
  definitionId: string;
  valueType: ServiceEntitlementValueType;
  resetPeriod: ServiceEntitlementResetPeriod;
  booleanValue: boolean | null;
  quota: bigint | null;
  startsAt: Date;
  endsAt: Date | null;
}

/** Must run in the caller's order/user-locked transaction; SQL verifies immutable plan facts. */
export async function ensureReceiptQuotaPool(
  tx: Pick<Prisma.TransactionClient, 'serviceEntitlementQuotaPool'>,
  input: ReceiptQuotaPoolInput,
): Promise<{ id: string }> {
  await tx.serviceEntitlementQuotaPool.createMany({ data: [input], skipDuplicates: true });
  const pool = await tx.serviceEntitlementQuotaPool.findUnique({ where: {
    orderLineId_definitionId: { orderLineId: input.orderLineId, definitionId: input.definitionId },
  } });
  if (!pool || pool.orderLineId !== input.orderLineId || pool.userId !== input.userId || pool.definitionId !== input.definitionId
    || pool.valueType !== input.valueType || pool.resetPeriod !== input.resetPeriod || pool.booleanValue !== input.booleanValue
    || pool.quota !== input.quota || pool.startsAt.getTime() !== input.startsAt.getTime()
    || (pool.endsAt?.getTime() ?? null) !== (input.endsAt?.getTime() ?? null)) {
    throw new ConflictException('Quỹ hạn mức của đơn hàng không khớp quyền lợi đã chốt.');
  }
  return { id: pool.id };
}
