import { Prisma } from '../../../generated/prisma/client';

/** Lifetime aggregates are independent of the recent-activity page. */
export function walletTotalsQuery(walletId: string, ownerId: string) {
  return Prisma.sql`
    SELECT
      (SELECT COALESCE(SUM(amount_minor),0)::text FROM gds_internal_holds
        WHERE wallet_id=${walletId}::uuid AND status='RESERVED') AS "paymentHeldMinor",
      COALESCE(SUM(CASE WHEN status IN ('PENDING','APPROVED','PROCESSING') THEN amount_minor ELSE 0 END),0)::text AS "withdrawalHeldMinor",
      COALESCE(SUM(CASE WHEN status='PAID' THEN amount_minor ELSE 0 END),0)::text AS "totalWithdrawnMinor"
    FROM gds_withdrawals WHERE wallet_id=${walletId}::uuid AND owner_id=${ownerId}::uuid`;
}

/** Recognition already includes earlier refund_pending adjustments. Do not subtract them twice. */
export function incomeTotalsQuery(ownerId: string) {
  return Prisma.sql`
    WITH periods AS (
      SELECT p.id, p.amount_minor,
        COALESCE(SUM(e.amount_minor) FILTER (WHERE e.kind='refund_pending'),0) AS pending_refunds,
        COALESCE(SUM(e.amount_minor) FILTER (WHERE e.kind IN ('recognized','refund_recognized')),0) AS recognized,
        COUNT(e.period_id) FILTER (WHERE e.kind='recognized') > 0 AS is_recognized,
        MIN(e.created_at) FILTER (WHERE e.kind='recognized') AS recognized_at,
        pr.review_required
      FROM revenue_earning_periods p
      LEFT JOIN revenue_ledger_entries e ON e.period_id=p.id
      LEFT JOIN gds_revenue_projections pr ON pr.period_id=p.id
      WHERE p.seller_id=${ownerId}::uuid
      GROUP BY p.id,p.amount_minor,pr.review_required
    )
    SELECT
      COALESCE(SUM(recognized),0)::text AS "recognizedMinor",
      COALESCE(SUM(CASE WHEN NOT is_recognized THEN amount_minor+pending_refunds ELSE 0 END),0)::text AS "pendingMinor",
      COALESCE(SUM(CASE WHEN is_recognized AND
        (review_required=true OR (review_required IS NULL AND recognized_at <=
          (SELECT revenue_cutoff_at FROM gds_withdrawal_settings WHERE id='global')))
        THEN recognized ELSE 0 END),0)::text AS "reviewPendingMinor"
    FROM periods`;
}

export type GdsWalletTotals = {
  paymentHeldMinor: string;
  withdrawalHeldMinor: string;
  totalWithdrawnMinor: string;
};

export type GdsIncomeSummary = {
  status: 'READY' | 'UNAVAILABLE';
  totalMinor: string | null;
  recognizedMinor: string | null;
  pendingMinor: string | null;
  reviewPendingMinor: string | null;
};

export const unavailableIncome = (): GdsIncomeSummary => ({
  status: 'UNAVAILABLE', totalMinor: null, recognizedMinor: null, pendingMinor: null, reviewPendingMinor: null,
});

export function isVndTotal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

export async function readIncomeSummary(tx: Prisma.TransactionClient, ownerId: string): Promise<GdsIncomeSummary> {
  // PostgreSQL marks a transaction aborted after a failed statement. A savepoint
  // isolates optional reporting failures without discarding the usable wallet.
  await tx.$executeRaw`SAVEPOINT gds_income_summary`;
  try {
    const [row] = await tx.$queryRaw<Array<Omit<GdsIncomeSummary, 'status' | 'totalMinor'>>>(incomeTotalsQuery(ownerId));
    if (!row || ![row.recognizedMinor, row.pendingMinor, row.reviewPendingMinor].every(isVndTotal)) {
      throw new Error('Invalid income totals');
    }
    return {
      status: 'READY', recognizedMinor: row.recognizedMinor, pendingMinor: row.pendingMinor,
      reviewPendingMinor: row.reviewPendingMinor,
      totalMinor: (BigInt(row.recognizedMinor!) + BigInt(row.pendingMinor!)).toString(),
    };
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT gds_income_summary`;
    return unavailableIncome();
  } finally {
    await tx.$executeRaw`RELEASE SAVEPOINT gds_income_summary`;
  }
}
