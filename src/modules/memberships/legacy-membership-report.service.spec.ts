import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LegacyMembershipReportService } from './legacy-membership-report.service';
import { LegacyMembershipReportController } from './legacy-membership-report.controller';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RoleName } from '../../../generated/prisma/client';

const startsAt = new Date('2025-01-01Z'); const endsAt = new Date('2025-02-01Z');
function fixture() {
  const order = {
    id: 'order', buyerId: 'buyer', currency: 'VND', payableAmountMinor: 100n, confirmedSettlementId: 'settlement', status: 'confirmed', fulfillmentStatus: 'fulfilled',
    lines: [{ id: 'line', productType: 'membership', productReferenceId: 'version', quantity: 1, currency: 'VND', finalAmountMinor: 100n }], refunds: [] as Array<{ id: string }>,
    membershipCheckoutIntent: { orderId: 'order', userId: 'buyer', versionId: 'version', startsAt, endsAt,
      version: { includedCourses: [], serviceEntitlements: [] }, removedCourses: [] },
    confirmedSettlement: { id: 'settlement', orderId: 'order', kind: 'provider_collection', disposition: 'matched', provider: 'payos', providerSettlementReference: 'reference',
      amountMinor: 100n, currency: 'VND', settledAt: startsAt, paymentAttemptId: 'attempt', paymentEventId: 'event',
      paymentAttempt: { id: 'attempt', orderId: 'order', provider: 'payos', providerPaymentIdentity: 'identity', providerOrderCode: 1n, status: 'paid', amountMinor: 100n, currency: 'VND' },
      paymentEvent: { id: 'event', paymentAttemptId: 'attempt', provider: 'payos', providerPaymentIdentity: 'identity', providerSettlementReference: 'reference', amountMinor: 100n, currency: 'VND', nextStatus: 'paid', providerOccurredAt: startsAt } },
    fulfillmentEffects: [{ orderId: 'order', orderLineId: 'line', effectType: 'MEMBERSHIP_TERM', sourceId: 'version', resourceType: 'membership_subscription', resourceId: 'subscription' }],
  };
  const tx = {
    commerceOrder: { findUnique: jest.fn().mockResolvedValue(order) },
    membershipSubscription: { findUnique: jest.fn().mockResolvedValue({ id: 'subscription', userId: 'buyer', versionId: 'version', sourceOrderLineId: 'line', startsAt, expiresAt: endsAt, status: 'active' }) },
    courseAccessGrant: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementGrant: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementUsage: { findMany: jest.fn().mockResolvedValue([]) },
    gdsInternalHold: { findUnique: jest.fn().mockResolvedValue({ walletId: 'wallet', status: 'CAPTURED', amountMinor: 100n, wallet: { buyerId: 'buyer' } }) },
    gdsInternalJournal: { findUnique: jest.fn().mockResolvedValue({ walletId: 'wallet', kind: 'CAPTURE', orderRef: 'order', amountMinor: 100n, availableDeltaMinor: 0n, heldDeltaMinor: -100n, clearingDeltaMinor: 100n }) },
  };
  const prisma = { $transaction: jest.fn().mockImplementation(callback => callback(tx)) };
  return { order, tx, prisma, service: new LegacyMembershipReportService(prisma as unknown as PrismaService) };
}
describe('Bounded historical membership report', () => {
  it('uses the existing platform-admin boundary', () => {
    expect(Reflect.getMetadata(ROLES_KEY, LegacyMembershipReportController)).toEqual([RoleName.platform_admin]);
  });
  it('reads one consistent snapshot without write-capable dependencies or private proof output', async () => {
    const h = fixture(); const result = await h.service.report('order');
    expect(result).toMatchObject({ status: 'reconciled', readOnly: true, findings: [], scope: 'single_order' });
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
    expect(JSON.stringify(result)).not.toContain('identity'); expect(JSON.stringify(result)).not.toContain('reference');
  });
  it('returns not found rather than an invented successful report', async () => {
    const h = fixture(); h.tx.commerceOrder.findUnique.mockResolvedValue(null);
    await expect(h.service.report('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['amount', 'event', 'provider'])('blocks invalid canonical %s evidence', async kind => {
    const h = fixture();
    if (kind === 'amount') h.order.confirmedSettlement.amountMinor = 99n;
    if (kind === 'event') h.order.confirmedSettlement.paymentEvent.providerPaymentIdentity = 'other';
    if (kind === 'provider') h.order.confirmedSettlement.provider = 'bank_transfer';
    expect(await h.service.report('order')).toMatchObject({ status: 'blocked', findings: [{ code: 'SOURCE_NOT_VERIFIED' }] });
    expect(h.tx.courseAccessGrant.findMany).not.toHaveBeenCalled();
  });
  it('holds unfulfilled or refunded orders without querying or recreating grants', async () => {
    const h = fixture(); h.order.fulfillmentStatus = 'processing';
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'ORDER_NOT_FULFILLED' }] });
    h.order.fulfillmentStatus = 'fulfilled'; h.order.refunds = [{ id: 'refund' }];
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'REFUND_REQUIRES_REVIEW' }] });
    expect(h.tx.courseAccessGrant.findMany).not.toHaveBeenCalled();
  });
  it('fails closed on oversized history, with explicit bounded queries', async () => {
    const h = fixture(); h.tx.courseAccessGrant.findMany.mockResolvedValue(Array(1001).fill({}));
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'RECONCILIATION_LIMIT_EXCEEDED' }] });
    expect(h.tx.courseAccessGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1001 }));
    expect(h.tx.serviceEntitlementUsage.findMany).not.toHaveBeenCalled();
  });
  it('rejects effects attributed to another order line', async () => {
    const h = fixture(); h.order.fulfillmentEffects[0].orderLineId = 'other';
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'FULFILLMENT_EFFECT_SOURCE_MISMATCH' }] });
    expect(h.tx.courseAccessGrant.findMany).not.toHaveBeenCalled();
  });
  it('includes grants belonging to another owner for mismatch detection rather than filtering them away', async () => {
    const h = fixture(); await h.service.report('order');
    const where = h.tx.courseAccessGrant.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('userId');
    expect(where.OR).toEqual([{ sourceId: 'line' }, { sourceId: { startsWith: 'line:' } }]);
  });
  it('reconciles canonical wallet capture and blocks an unbalanced journal or another owner', async () => {
    const h = fixture();
    Object.assign(h.order.confirmedSettlement, { kind: 'wallet_capture', disposition: 'internal', provider: 'gds', providerSettlementReference: 'gds:order:order', paymentAttemptId: null, paymentEventId: null, paymentAttempt: null, paymentEvent: null });
    expect(await h.service.report('order')).toMatchObject({ status: 'reconciled' });
    h.tx.gdsInternalJournal.findUnique.mockResolvedValue({ walletId: 'wallet', kind: 'CAPTURE', orderRef: 'order', amountMinor: 100n, availableDeltaMinor: 0n, heldDeltaMinor: -99n, clearingDeltaMinor: 100n });
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'SOURCE_NOT_VERIFIED' }] });
    h.tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId: 'wallet', status: 'CAPTURED', amountMinor: 100n, wallet: { buyerId: 'other' } });
    expect(await h.service.report('order')).toMatchObject({ findings: [{ code: 'SOURCE_NOT_VERIFIED' }] });
  });
});
