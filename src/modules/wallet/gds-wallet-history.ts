import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';

export type HistoryFilter = 'all' | 'incoming' | 'outgoing' | 'payments' | 'withdrawals';
export interface HistoryQuery { filter: HistoryFilter; limit: number; before?: { micros: string; id: string } }
const filters = new Set(['all','incoming','outgoing','payments','withdrawals']);
export function encodeHistoryCursor(owner: string, filter: HistoryFilter, micros: string, id: string): string {
  return Buffer.from(JSON.stringify([1,owner,filter,micros,id])).toString('base64url');
}
export function parseHistoryQuery(owner: string, filter: unknown = 'all', limit: unknown = '20', cursor?: unknown): HistoryQuery {
  if (typeof filter !== 'string' || !filters.has(filter) || typeof limit !== 'string' || !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)) throw new BadRequestException('GDS_HISTORY_INVALID_QUERY');
  const result: HistoryQuery = { filter: filter as HistoryFilter, limit: Number(limit) };
  if (cursor === undefined) return result;
  try {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== owner || value[2] !== filter ||
        typeof value[3] !== 'string' || !/^\d{1,18}$/.test(value[3]) || typeof value[4] !== 'string' ||
        !/^(journal|withdrawal)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value[4])) throw new Error();
    result.before = { micros: value[3], id: value[4] };
    return result;
  } catch { throw new BadRequestException('GDS_HISTORY_INVALID_CURSOR'); }
}

export interface HistoryItem {
  id: string; type: string; amountMinor: string; occurredAt: string;
  withdrawalId?: string; status?: string; bankCode?: string; bankShortName?: string; accountNumber?: string;
}
type HistoryDbRow = Omit<HistoryItem,'occurredAt'> & { occurredAt: Date | string; micros: string };

export function historyQuery(owner: string, query: HistoryQuery) {
  const conditions: Record<HistoryFilter, Prisma.Sql> = {
    all: Prisma.sql`TRUE`, incoming: Prisma.sql`type IN ('TOPUP_CREDIT','REVENUE_CREDIT')`,
    outgoing: Prisma.sql`type IN ('CAPTURE','REVENUE_REVERSAL','WITHDRAWAL_PAID') OR (type='WITHDRAWAL' AND status='PAID')`,
    payments: Prisma.sql`type='CAPTURE'`, withdrawals: Prisma.sql`type IN ('WITHDRAWAL','WITHDRAWAL_RESERVE','WITHDRAWAL_RELEASE','WITHDRAWAL_PAID')`,
  };
  return Prisma.sql`
    WITH activity AS (
      SELECT 'journal-'||j.id::text AS id, j.kind AS type, j.amount_minor::text AS "amountMinor", j.occurred_at AS "occurredAt",
        NULL::text AS "withdrawalId", NULL::text AS status, NULL::text AS "bankCode", NULL::text AS "bankShortName", NULL::text AS "accountNumber"
      FROM gds_internal_journal j JOIN gds_internal_wallets w ON w.id=j.wallet_id
      WHERE w.buyer_id=${owner}::uuid
        AND j.kind IN ('TOPUP_CREDIT','REVENUE_CREDIT','REVENUE_REVERSAL','CAPTURE','RESERVE','RELEASE','WITHDRAWAL_RESERVE','WITHDRAWAL_RELEASE','WITHDRAWAL_PAID')
        AND NOT (j.kind IN ('WITHDRAWAL_RESERVE','WITHDRAWAL_RELEASE','WITHDRAWAL_PAID') AND EXISTS (
          SELECT 1 FROM gds_withdrawals d WHERE d.wallet_id=j.wallet_id AND d.owner_id=${owner}::uuid AND d.id::text=j.order_ref))
      UNION ALL
      SELECT 'withdrawal-'||d.id::text, 'WITHDRAWAL', d.amount_minor::text, d.created_at,
        d.id::text, d.status, d.bank_code, d.bank_short_name, '••••'||RIGHT(d.account_number,4)
      FROM gds_withdrawals d JOIN gds_internal_wallets w ON w.id=d.wallet_id
      WHERE d.owner_id=${owner}::uuid AND w.buyer_id=${owner}::uuid
    ), ordered AS (
      SELECT *, FLOOR(EXTRACT(EPOCH FROM "occurredAt")*1000000)::bigint AS sort_time FROM activity
      WHERE (${conditions[query.filter]})
    )
    SELECT id,type,"amountMinor","occurredAt","withdrawalId",status,"bankCode","bankShortName","accountNumber", sort_time::text AS micros
    FROM ordered
    ${query.before ? Prisma.sql`WHERE (sort_time,id COLLATE "C") < (${query.before.micros}::bigint,${query.before.id} COLLATE "C")` : Prisma.empty}
    ORDER BY sort_time DESC, id COLLATE "C" DESC LIMIT ${query.limit+1}`;
}

export async function readHistoryPage(db: Pick<Prisma.TransactionClient,'$queryRaw'>, owner: string, query: HistoryQuery) {
  const rows = await db.$queryRaw<HistoryDbRow[]>(historyQuery(owner, query));
  const selected = rows.slice(0,query.limit); const last = selected.at(-1);
  const hasMore = rows.length > query.limit;
  return { items: selected.map(row => ({
    id:row.id,type:row.type,amountMinor:row.amountMinor,occurredAt:new Date(row.occurredAt).toISOString(),
    ...(row.withdrawalId ? {withdrawalId:row.withdrawalId,status:row.status,bankCode:row.bankCode,
      ...(row.bankShortName ? {bankShortName:row.bankShortName}:{}),accountNumber:row.accountNumber}:{}),
  } satisfies HistoryItem)), hasMore,
    nextCursor: hasMore && last ? encodeHistoryCursor(owner,query.filter,last.micros,last.id) : null };
}
