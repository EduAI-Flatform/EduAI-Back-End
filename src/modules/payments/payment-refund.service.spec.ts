import { ConflictException } from '@nestjs/common';
import {
  CommerceFulfillmentStatus, CommerceIdempotencyStatus, CommerceOrderStatus, CommerceProductType, CommerceReconciliationStatus,
  CommerceRefundStatus,
} from '../../../generated/prisma/client';
import { PaymentRefundService } from './payment-refund.service';

const updatedAt = new Date('2026-08-27T09:00:00Z');
const line = (productType: CommerceProductType = CommerceProductType.course) => ({
  id: 'line-id', orderId: 'order-id', productType, productReferenceId: 'product-ref',
  finalAmountMinor: 100n, displayTitle: 'Safe product',
});
const refund = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund-id', orderId: 'order-id', settlementId: 'settlement-id',
  reconciliationCaseId: null, status: CommerceRefundStatus.requested,
  statusOperationId: null, amountMinor: 40n, currency: 'VND', provider: 'payos',
  externalReference: null, requestedById: 'admin-id', recordedById: null,
  reasonCode: 'CUSTOMER_REQUEST', rejectionReasonCode: null,
  createdAt: updatedAt, updatedAt, recordedAt: null, rejectedAt: null,
  allocations: [{ id: 'allocation-id', refundId: 'refund-id', orderLineId: 'line-id', amountMinor: 40n, currency: 'VND', createdAt: updatedAt, orderLine: line() }],
  order: {
    buyerId: 'learner-id', orderNumber: 'ORD-1', status: CommerceOrderStatus.confirmed,
    fulfillmentStatus: CommerceFulfillmentStatus.fulfilled, confirmedSettlementId: 'settlement-id',
  },
  settlement: { provider: 'payos', amountMinor: 100n, currency: 'VND', settledAt: updatedAt },
  requestedBy: { id: 'admin-id', email: 'admin@example.test', fullName: 'Admin' },
  recordedBy: null, reconciliationCase: null, ...overrides,
});

function setup(current = refund()) {
  const recorded = refund({
    ...current, status: CommerceRefundStatus.recorded, externalReference: 'manual-ref',
    recordedById: 'admin-id', recordedAt: updatedAt,
  });
  const tx: any = {
    $queryRaw: jest.fn(),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
      update: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
    },
    commerceSettlement: { findUnique: jest.fn() },
    commerceRefund: {
      create: jest.fn(), findUnique: jest.fn().mockResolvedValue(current),
      findUniqueOrThrow: jest.fn().mockResolvedValue(recorded), update: jest.fn(),
    },
    commerceRefundAllocation: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 40n } }) },
    commerceLifecycleEvent: { create: jest.fn() },
    membershipSubscription: { updateMany: jest.fn() },
    courseAccessGrant: { updateMany: jest.fn() },
    serviceEntitlementGrant: { updateMany: jest.fn() },
    commerceReconciliationCase: { update: jest.fn() },
    commerceOrder: { update: jest.fn() },
  };
  const prisma: any = {
    $transaction: jest.fn((value: any) => typeof value === 'function' ? value(tx) : Promise.all(value)),
    commerceRefund: { count: jest.fn(), findMany: jest.fn() },
  };
  const audit: any = { record: jest.fn() };
  const access: any = { revokeGrant: jest.fn() };
  const service = new PaymentRefundService(
    prisma, { commerce: { idempotencySecret: 's'.repeat(32) } } as never, audit, access,
  );
  return { service, tx, audit, access };
}

describe('PaymentRefundService', () => {
  it('creates one immutable allocation request under hashed idempotency', async () => {
    const { service, tx, audit } = setup();
    tx.commerceSettlement.findUnique.mockResolvedValue({
      id: 'settlement-id', orderId: 'order-id', provider: 'payos',
      kind: 'provider_collection', amountMinor: 100n, reconciliationCase: null,
      order: { lines: [line()] },
    });
    tx.commerceRefund.create.mockResolvedValue(refund());
    await service.create('admin-id', 'refund-key-123', {
      settlementId: 'settlement-id', amountMinor: '40', reasonCode: 'CUSTOMER_REQUEST',
      allocations: [{ orderLineId: 'line-id', amountMinor: '40' }],
    });
    expect(tx.commerceRefund.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amountMinor: 40n, allocations: { create: [expect.objectContaining({ amountMinor: 40n })] } }),
    }));
    expect(tx.commerceIdempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: CommerceIdempotencyStatus.in_progress,
      }),
    }));
    expect(tx.commerceIdempotencyRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'idempotency-id' },
      data: expect.objectContaining({ status: CommerceIdempotencyStatus.completed }),
    }));
    expect(audit.record).toHaveBeenCalled();
  });

  it('preserves access for a partial recorded refund', async () => {
    const { service, tx, access, audit } = setup();
    await service.record('admin-id', 'refund-id', { externalReference: 'manual-ref', confirmExternalAction: true, expectedUpdatedAt: updatedAt.toISOString() });
    expect(access.revokeGrant).not.toHaveBeenCalled();
    expect(tx.membershipSubscription.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ accessConsequences: ['PARTIAL_ACCESS_PRESERVED'] }),
    }), tx);
  });

  it('resolves late review without revoking access from a non-fulfilling collection', async () => {
    const current = refund({
      amountMinor: 100n,
      allocations: [{ ...refund().allocations[0], amountMinor: 100n }],
      reconciliationCaseId: 'case-id',
      reconciliationCase: { id: 'case-id', status: CommerceReconciliationStatus.open },
      order: {
        buyerId: 'learner-id', orderNumber: 'ORD-1', status: CommerceOrderStatus.late_payment_review,
        fulfillmentStatus: CommerceFulfillmentStatus.not_started, confirmedSettlementId: null,
      },
    });
    const { service, tx, access } = setup(current);
    tx.commerceRefundAllocation.aggregate.mockResolvedValue({ _sum: { amountMinor: 100n } });
    await service.record('admin-id', 'refund-id', { externalReference: 'manual-ref', confirmExternalAction: true, expectedUpdatedAt: updatedAt.toISOString() });
    expect(access.revokeGrant).not.toHaveBeenCalled();
    expect(tx.commerceReconciliationCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommerceReconciliationStatus.resolved, resolution: 'refund' }),
    }));
    expect(tx.commerceOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommerceOrderStatus.late_payment_refunded }),
    }));
  });

  it('revokes only the fully refunded course-purchase grant from the confirming settlement', async () => {
    const current = refund({
      amountMinor: 100n,
      allocations: [{ ...refund().allocations[0], amountMinor: 100n }],
    });
    const { service, tx, access } = setup(current);
    tx.commerceRefundAllocation.aggregate.mockResolvedValue({ _sum: { amountMinor: 100n } });
    await service.record('admin-id', 'refund-id', {
      externalReference: 'manual-ref', confirmExternalAction: true,
      expectedUpdatedAt: updatedAt.toISOString(),
    });
    expect(access.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'learner-id', sourceId: 'line-id',
    }), 'FULL_REFUND_RECORDED', tx);
  });

  it('cancels only the source membership term and grants after a full refund', async () => {
    const membershipLine = line(CommerceProductType.membership);
    const current = refund({
      amountMinor: 100n,
      allocations: [{ ...refund().allocations[0], amountMinor: 100n, orderLine: membershipLine }],
    });
    const { service, tx, access } = setup(current);
    tx.commerceRefundAllocation.aggregate.mockResolvedValue({ _sum: { amountMinor: 100n } });
    await service.record('admin-id', 'refund-id', { externalReference: 'manual-ref', confirmExternalAction: true, expectedUpdatedAt: updatedAt.toISOString() });
    expect(tx.membershipSubscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceOrderLineId: 'line-id' }),
    }));
    expect(tx.courseAccessGrant.updateMany).toHaveBeenCalled();
    expect(tx.serviceEntitlementGrant.updateMany).toHaveBeenCalled();
    expect(access.revokeGrant).not.toHaveBeenCalled();
  });

  it('rejects replay with a different external reference', async () => {
    const current = refund({ status: CommerceRefundStatus.recorded, externalReference: 'original-ref' });
    const { service } = setup(current);
    await expect(service.record('admin-id', 'refund-id', {
      externalReference: 'different-ref', confirmExternalAction: true, expectedUpdatedAt: updatedAt.toISOString(),
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
