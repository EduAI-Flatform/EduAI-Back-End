import { textWorkbook } from '../../common/exports/text-workbook';

interface AffiliateExportRow {
  userName: string; kind: string; orderNumber: string; orderStatus: string;
  accruedAmountMinor: string | null; createdAt: Date; policyRevisionId: string;
}
export function affiliateWorkbook(rows: AffiliateExportRow[]) {
  return textWorkbook([
    ['User', 'Referral type', 'Order', 'Order status', 'Accrued VND', 'Created at', 'Policy revision'],
    ...rows.map(row => [row.userName, row.kind, row.orderNumber, row.orderStatus,
      row.accruedAmountMinor ?? '', row.createdAt.toISOString(), row.policyRevisionId]),
  ], 'Affiliate');
}
