import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { activityPointExpirySettlements, pendingActivityPointExpiries, type PointExpiryEntry } from './activity-point-expiry';

export const pointLedgerSelect = {
  id: true, userId: true, redemptionId: true, kind: true, amount: true, adjustmentDirection: true,
  sourceType: true, sourceId: true, occurredAt: true, expiresAt: true, postingSequence: true, metadata: true,
} satisfies Prisma.TmiLedgerEntrySelect;
export type PointLedgerRow = Prisma.TmiLedgerEntryGetPayload<{ select: typeof pointLedgerSelect }> & PointExpiryEntry;

function withRefundProvenance(row: Prisma.TmiLedgerEntryGetPayload<{ select: typeof pointLedgerSelect }>): PointLedgerRow {
  if (row.sourceType !== 'platform_activity_refund') return row;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  if (typeof metadata.refundOfEntryId !== 'string' || typeof metadata.refundOfDebitId !== 'string')
    throw new Error('POINT_ACTIVITY_REFUND_MISMATCH');
  return { ...row, refundOfEntryId: metadata.refundOfEntryId, refundOfDebitId: metadata.refundOfDebitId };
}

@Injectable()
export class PointLedgerService {
  constructor(private readonly audit: AuditService) {}

  async load(client: Prisma.TransactionClient, userId: string): Promise<PointLedgerRow[]> {
    const rows = await client.tmiLedgerEntry.findMany({ where: { userId }, select: pointLedgerSelect });
    return rows.map(withRefundProvenance);
  }

  project(entries: PointExpiryEntry[], at: Date) {
    let earned = 0, spent = 0, expired = 0;
    for (const entry of entries) {
      if (!Number.isInteger(entry.amount) || entry.amount <= 0) continue;
      if (entry.kind === 'earn' || entry.kind === 'refund' || (entry.kind === 'adjustment' && entry.adjustmentDirection === 'credit')) earned += entry.amount;
      if (entry.kind === 'redeem' || (entry.kind === 'adjustment' && entry.adjustmentDirection === 'debit')) spent += entry.amount;
      if (entry.kind === 'expiry') { spent += entry.amount; expired += entry.amount; }
    }
    const pending = pendingActivityPointExpiries(entries, at).reduce((sum, lot) => sum + lot.amount, 0);
    return { current: Math.max(0, earned - spent - pending), earned, spent: spent + pending, expired: expired + pending };
  }

  /** Caller holds the existing users FOR UPDATE lock for the entire transaction. */
  async settle(tx: Prisma.TransactionClient, userId: string, actorId: string, at: Date): Promise<PointLedgerRow[]> {
    const entries = await this.load(tx, userId);
    const due = activityPointExpirySettlements(entries, at);
    if (due.length === 0) return entries;
    const existing = await tx.pointExpirySettlement.findMany({
      where: { creditEntryId: { in: due.map(lot => lot.entryId) } }, select: { creditEntryId: true, amount: true },
    });
    const settled = new Map(existing.map(receipt => [receipt.creditEntryId, receipt]));
    for (const lot of due) {
      if (settled.has(lot.entryId)) {
        if (lot.amount !== 0 || settled.get(lot.entryId)!.amount !== 0) throw new Error('POINT_ACTIVITY_EXPIRY_RECEIPT_MISMATCH');
        continue;
      }
      const posting = lot.amount > 0 ? await tx.tmiLedgerEntry.create({
        data: { userId, kind: 'expiry', amount: lot.amount, sourceType: 'platform_activity_expiry',
          sourceId: lot.entryId, actorId, occurredAt: at }, select: pointLedgerSelect,
      }) : null;
      const receipt = await tx.pointExpirySettlement.create({ data: { userId, creditEntryId: lot.entryId,
        amount: lot.amount, settledAt: at, ledgerEntryId: posting?.id ?? null } });
      await this.audit.record({ actorId, action: AuditAction.PointActivityExpired,
        target: { type: 'point_expiry_settlement', id: receipt.id },
        metadata: { userId, creditEntryId: lot.entryId, amount: lot.amount } }, tx);
      if (posting) entries.push(withRefundProvenance(posting));
    }
    return entries;
  }
}
