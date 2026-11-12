import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { LegacyMembershipInventoryQuery } from './dto/legacy-membership-inventory.dto';
import { LegacyMembershipInventoryService } from './legacy-membership-inventory.service';

const id = '00000000-0000-4000-8000-000000000001';
const lineId = '00000000-0000-4000-8000-000000000002';
const courseId = '00000000-0000-4000-8000-000000000003';
function harness() {
  const tx = {
    commerceOrder: { findMany: jest.fn().mockResolvedValue([]) },
    membershipSubscription: { findMany: jest.fn().mockResolvedValue([]) },
    courseAccessGrant: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementGrant: { findMany: jest.fn().mockResolvedValue([]) },
    commerceOrderLine: { findMany: jest.fn().mockResolvedValue([{ id: lineId, orderId: id, productType: 'membership', order: { buyerId: 'buyer' } }]) },
  };
  const prisma = { $transaction: jest.fn().mockImplementation(callback => callback(tx)) };
  return { tx, prisma, service: new LegacyMembershipInventoryService(prisma as unknown as PrismaService) };
}
describe('Legacy membership source inventory', () => {
  it('validates source, bounded page size and UUID cursor at the boundary', () => {
    expect(validateSync(plainToInstance(LegacyMembershipInventoryQuery, { source: 'orders', pageSize: '20', after: id }))).toEqual([]);
    for (const invalid of [{ source: 'users' }, { source: 'orders', pageSize: 101 }, { source: 'orders', pageSize: 0 }, { source: 'orders', after: 'bad' }]) {
      expect(validateSync(plainToInstance(LegacyMembershipInventoryQuery, invalid)).length).toBeGreaterThan(0);
    }
  });
  it('paginates with a bounded extra row and reports only page-local scope', async () => {
    const h = harness(); h.tx.commerceOrder.findMany.mockResolvedValue([{ id }, { id: lineId }]);
    const result = await h.service.list({ source: 'orders', pageSize: 1 });
    expect(result).toMatchObject({ readOnly: true, source: 'orders', scope: 'source_page', hasMore: true, nextCursor: id,
      migrationReadiness: 'not_assessed', items: [{ id, orderId: id, code: 'ORDER_RECONCILIATION_REQUIRED' }] });
    expect(h.tx.commerceOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, orderBy: { id: 'asc' } }));
  });
  it('keeps a stable keyset without requiring the cursor row to still exist', async () => {
    const h = harness(); await h.service.list({ source: 'subscriptions', pageSize: 20, after: id });
    expect(h.tx.membershipSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { gt: id } }, take: 21 }));
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });
  it('includes subscriptions with no source order instead of dropping them with an inner join', async () => {
    const h = harness(); h.tx.membershipSubscription.findMany.mockResolvedValue([{ id, userId: 'buyer', sourceOrderLineId: null }]);
    expect(await h.service.list({ source: 'subscriptions', pageSize: 20 })).toMatchObject({ hasMore: false, nextCursor: null,
      items: [{ id, orderId: null, code: 'SOURCE_ORDER_MISSING' }] });
  });
  it('resolves valid grace sources in one bounded batch and detects owner mismatch', async () => {
    const h = harness(); h.tx.courseAccessGrant.findMany.mockResolvedValue([
      { id, userId: 'buyer', courseId, sourceType: 'membership_grace', sourceId: `${lineId}:${courseId}` },
      { id: lineId, userId: 'other', courseId, sourceType: 'membership', sourceId: lineId },
    ]);
    const result = await h.service.list({ source: 'course_grants', pageSize: 20 });
    expect(result.items.map(item => item.code)).toEqual(['ORDER_RECONCILIATION_REQUIRED', 'SOURCE_ORDER_MISMATCH']);
    expect(h.tx.commerceOrderLine.findMany).toHaveBeenCalledTimes(1);
  });
  it('does not mistake unverified receipt access for a purchased membership source', async () => {
    const h = harness(); h.tx.serviceEntitlementGrant.findMany.mockResolvedValue([{ id, userId: 'buyer', sourceType: 'UNVERIFIED_RECEIPT_ACCESS', sourceId: `${id}:${lineId}` }]);
    expect(await h.service.list({ source: 'service_grants', pageSize: 20 })).toMatchObject({ items: [{ code: 'UNVERIFIED_RECEIPT_ACCESS', orderId: null }] });
    expect(h.tx.commerceOrderLine.findMany).not.toHaveBeenCalled();
  });
  it('reports malformed, orphaned and non-membership source lines explicitly', async () => {
    const h = harness(); h.tx.courseAccessGrant.findMany.mockResolvedValue([
      { id, userId: 'buyer', courseId, sourceType: 'membership', sourceId: 'broken' },
      { id: lineId, userId: 'buyer', courseId, sourceType: 'membership_grace', sourceId: `${lineId}:${id}` },
    ]);
    expect((await h.service.list({ source: 'course_grants', pageSize: 20 })).items.every(item => item.code === 'INVALID_SOURCE_REFERENCE')).toBe(true);
    h.tx.membershipSubscription.findMany.mockResolvedValue([{ id, userId: 'buyer', sourceOrderLineId: lineId }]);
    h.tx.commerceOrderLine.findMany.mockResolvedValue([]);
    expect((await h.service.list({ source: 'subscriptions', pageSize: 20 })).items[0].code).toBe('SOURCE_ORDER_MISSING');
  });
  it('does not filter revoked/expired source rows or return user identities', async () => {
    const h = harness(); h.tx.serviceEntitlementGrant.findMany.mockResolvedValue([{ id, userId: 'buyer', sourceType: 'membership', sourceId: lineId }]);
    const result = await h.service.list({ source: 'service_grants', pageSize: 20 });
    expect(h.tx.serviceEntitlementGrant.findMany.mock.calls[0][0].where).not.toHaveProperty('status');
    expect(JSON.stringify(result)).not.toContain('buyer');
  });
  it('retains other service sources as explicit exceptions instead of hiding reusable service data', async () => {
    const h = harness(); h.tx.serviceEntitlementGrant.findMany.mockResolvedValue([{ id, userId: 'buyer', sourceType: 'ADMIN', sourceId: lineId }]);
    expect((await h.service.list({ source: 'service_grants', pageSize: 20 })).items[0].code).toBe('UNSUPPORTED_SERVICE_SOURCE');
    expect(h.tx.serviceEntitlementGrant.findMany.mock.calls[0][0].where).not.toHaveProperty('sourceType');
  });
});
