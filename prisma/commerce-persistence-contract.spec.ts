import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readSchemaPart = (fileName: string): string =>
  readFileSync(join(process.cwd(), 'prisma', 'schema', fileName), 'utf8');

const modelBlock = (schema: string, modelName: string): string => {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) {
    throw new Error(`Missing Prisma model ${modelName}`);
  }
  return match[1];
};

describe('Sprint 23 commerce persistence schema contract', () => {
  it('keeps Course authoritative for current price while using 64-bit immutable money', () => {
    const courseSchema = readSchemaPart('30-course.prisma');
    const commerceSchema = readSchemaPart('100-commerce.prisma');
    const product = modelBlock(commerceSchema, 'CommerceProduct');

    expect(courseSchema).toContain('priceAmountMinor Int?');
    expect(courseSchema).toContain('priceCurrency String?');
    expect(product).not.toMatch(/title|priceAmountMinor|currency/);
    expect(commerceSchema).toContain('unitListPriceAmountMinor BigInt');
    expect(commerceSchema).toMatch(/payableAmountMinor\s+BigInt/);
    expect(commerceSchema).toContain('currency');
    expect(commerceSchema).not.toContain('Decimal');
    expect(commerceSchema).not.toContain('Float');
  });

  it('defines the complete persistence boundary without provider or client secrets', () => {
    const commerceSchema = readSchemaPart('100-commerce.prisma');
    const expectedModels = [
      'CommerceProduct',
      'CommerceCart',
      'CommerceCartLine',
      'CommerceOrder',
      'CommerceOrderLine',
      'CommerceOrderLineBenefit',
      'CommercePromotionReservation',
      'CommercePaymentAttempt',
      'CommercePaymentEvent',
      'CommerceSettlement',
      'CommerceReconciliationCase',
      'CommerceRefund',
      'CommerceRefundAllocation',
      'CommerceLifecycleEvent',
      'CommerceIdempotencyRecord',
    ];

    for (const modelName of expectedModels) {
      expect(() => modelBlock(commerceSchema, modelName)).not.toThrow();
    }

    expect(commerceSchema).not.toMatch(/rawBody|rawPayload|signature|paymentLink|qrPayload/);
    expect(commerceSchema).not.toMatch(/\bidempotencyKey\b/);
    expect(modelBlock(commerceSchema, 'CommerceIdempotencyRecord')).toContain(
      'keyHash',
    );
  });

  it('models learner ownership and immutable order-line snapshots explicitly', () => {
    const commerceSchema = readSchemaPart('100-commerce.prisma');
    const cart = modelBlock(commerceSchema, 'CommerceCart');
    const order = modelBlock(commerceSchema, 'CommerceOrder');
    const line = modelBlock(commerceSchema, 'CommerceOrderLine');

    expect(cart).toContain('buyerId');
    expect(cart).toContain('@@index([buyerId, status])');
    expect(order).toContain('buyerId');
    expect(order).toContain('@@index([buyerId, createdAt])');
    expect(line).toContain('productType');
    expect(line).toContain('productReferenceId');
    expect(line).toContain('sellerId');
    expect(line).toContain('displayTitle');
    expect(line).toContain('quantity');
    expect(line).toContain('unitListPriceAmountMinor');
    expect(line).toContain('discountAmountMinor');
    expect(line).toContain('finalAmountMinor');
  });

  it('keeps order, fulfillment, payment, reservation, and refund lifecycles orthogonal', () => {
    const commerceSchema = readSchemaPart('100-commerce.prisma');

    expect(modelBlock(commerceSchema, 'CommerceOrder')).toEqual(
      expect.stringContaining('fulfillmentStatus'),
    );
    expect(modelBlock(commerceSchema, 'CommercePaymentAttempt')).toContain('status');
    expect(modelBlock(commerceSchema, 'CommercePromotionReservation')).toContain(
      'status',
    );
    expect(modelBlock(commerceSchema, 'CommerceRefund')).toContain('status');
    expect(modelBlock(commerceSchema, 'CommerceSettlement')).toContain('kind');
    expect(modelBlock(commerceSchema, 'CommerceReconciliationCase')).toContain(
      'resolution',
    );
    expect(modelBlock(commerceSchema, 'CommerceLifecycleEvent')).toContain(
      'entityType',
    );
  });

  it('retains normalized collection evidence and versioned safe idempotency hashes', () => {
    const commerceSchema = readSchemaPart('100-commerce.prisma');
    const paymentEvent = modelBlock(commerceSchema, 'CommercePaymentEvent');
    const settlement = modelBlock(commerceSchema, 'CommerceSettlement');
    const idempotency = modelBlock(commerceSchema, 'CommerceIdempotencyRecord');

    expect(paymentEvent).toContain('amountMinor');
    expect(paymentEvent).toContain('currency');
    expect(paymentEvent).toContain('providerOccurredAt');
    expect(settlement).toContain('providerSettlementReference');
    expect(idempotency).toContain('keyHashVersion');
    expect(idempotency).toContain('requestCanonicalizationVersion');
    expect(idempotency).toContain('lockedUntil');
  });

  it('binds reservable benefits to existing quota authorities', () => {
    const commerceSchema = readSchemaPart('100-commerce.prisma');
    const reservation = modelBlock(
      commerceSchema,
      'CommercePromotionReservation',
    );

    expect(reservation).toContain('voucherId');
    expect(reservation).toContain('scholarshipAwardId');
    expect(reservation).toContain('@@index([voucherId, status])');
    expect(reservation).toContain('@@index([buyerId, voucherId, status])');
  });
});
