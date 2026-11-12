import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LEGACY_INVENTORY_SOURCES, LEGACY_SOURCE_UUID, LegacyMembershipInventoryQuery } from './dto/legacy-membership-inventory.dto';

type SourceRow = { id: string; userId?: string; sourceOrderLineId?: string | null; sourceType?: string; sourceId?: string; courseId?: string; versionId?: string };
type InventoryItem = { id: string; orderId: string | null; code: string };

@Injectable()
export class LegacyMembershipInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  list(query: LegacyMembershipInventoryQuery) {
    return this.prisma.$transaction(async tx => {
      const observedAt = new Date().toISOString();
      const rows = await this.sourceRows(tx, query);
      const hasMore = rows.length > query.pageSize;
      const page = rows.slice(0, query.pageSize);
      let items: InventoryItem[];
      if (query.source === 'orders') {
        items = page.map(row => ({ id: row.id, orderId: row.id, code: 'ORDER_RECONCILIATION_REQUIRED' }));
      } else {
        const references = page.map(row => this.sourceReference(row));
        const lineIds = [...new Set(references.filter((id): id is string => id !== null))];
        // One bounded batch, including other owners for mismatch detection.
        const lines = lineIds.length ? await tx.commerceOrderLine.findMany({
          where: { id: { in: lineIds } }, take: query.pageSize,
          select: { id: true, orderId: true, productType: true, productReferenceId: true, order: { select: { buyerId: true } } },
        }) : [];
        const byId = new Map(lines.map(line => [line.id.toLowerCase(), line]));
        items = page.map((row, index) => {
          const item: InventoryItem = { id: row.id, orderId: null, code: 'SOURCE_ORDER_MISSING' };
          if (row.sourceType === 'unverified_receipt_access' || row.sourceType === 'UNVERIFIED_RECEIPT_ACCESS') return { ...item, code: 'UNVERIFIED_RECEIPT_ACCESS' };
          if (query.source === 'service_grants' && row.sourceType !== 'membership') return { ...item, code: 'UNSUPPORTED_SERVICE_SOURCE' };
          const reference = references[index];
          if (reference === null) return { ...item, code: row.sourceOrderLineId === null ? 'SOURCE_ORDER_MISSING' : 'INVALID_SOURCE_REFERENCE' };
          const line = byId.get(reference);
          if (!line) return item;
          if (line.productType !== 'membership' || line.order.buyerId !== row.userId || (row.versionId && line.productReferenceId !== row.versionId)) return { ...item, code: 'SOURCE_ORDER_MISMATCH' };
          return { ...item, orderId: line.orderId, code: 'ORDER_RECONCILIATION_REQUIRED' };
        });
      }
      return { source: query.source, scope: 'source_page' as const, readOnly: true as const, observedAt,
        migrationReadiness: 'not_assessed' as const, requiredSources: LEGACY_INVENTORY_SOURCES,
        items, pageSize: query.pageSize, hasMore, nextCursor: hasMore ? page[page.length - 1].id : null };
    }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
  }

  private sourceReference(row: SourceRow): string | null {
    if (row.sourceOrderLineId !== undefined) return row.sourceOrderLineId && LEGACY_SOURCE_UUID.test(row.sourceOrderLineId) ? row.sourceOrderLineId.toLowerCase() : null;
    if (row.sourceType === 'membership_grace') {
      const parts = row.sourceId?.split(':');
      return parts?.length === 2 && LEGACY_SOURCE_UUID.test(parts[0]) && parts[1].toLowerCase() === row.courseId?.toLowerCase() ? parts[0].toLowerCase() : null;
    }
    return row.sourceType === 'membership' && row.sourceId && LEGACY_SOURCE_UUID.test(row.sourceId) ? row.sourceId.toLowerCase() : null;
  }

  private sourceRows(tx: Prisma.TransactionClient, query: LegacyMembershipInventoryQuery): Promise<SourceRow[]> {
    const where = query.after ? { id: { gt: query.after } } : {};
    const paging = { take: query.pageSize + 1, orderBy: { id: 'asc' as const } };
    switch (query.source) {
      case 'orders': return tx.commerceOrder.findMany({ ...paging, where: { ...where,
        OR: [{ lines: { some: { productType: 'membership' } } }, { membershipCheckoutIntent: { isNot: null } }] }, select: { id: true } });
      case 'subscriptions': return tx.membershipSubscription.findMany({ ...paging, where,
        select: { id: true, userId: true, versionId: true, sourceOrderLineId: true } });
      case 'course_grants': return tx.courseAccessGrant.findMany({ ...paging, where: { ...where, sourceType: { in: ['membership', 'membership_grace', 'unverified_receipt_access'] } },
        select: { id: true, userId: true, courseId: true, sourceType: true, sourceId: true } });
      case 'service_grants': return tx.serviceEntitlementGrant.findMany({ ...paging, where,
        select: { id: true, userId: true, sourceType: true, sourceId: true } });
    }
  }
}
