export { receiptSandboxEnabled, receiptEarlyAccessEnabled } from '../../common/security/receipt-sandbox-policy';

export interface ReceiptClaimFields {
  bankBin: string | null;
  accountNumber: string | null;
  beneficiaryName: string | null;
  amountMinor: string | null;
  transferContent: string | null;
  occurredAt: string | null;
  transactionId: string | null;
}
export interface ReceiptExpectedFacts {
  bankBin: string;
  accountNumber: string;
  beneficiaryName: string;
  amountMinor: string;
  transferContent: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface ReceiptAssessment {
  status: 'MATCHED_CLAIM' | 'REVIEW_REQUIRED';
  financialProof: false;
  warnings: string[];
  normalized: ReceiptClaimFields;
}

const normalizeName = (value: string | null) => value?.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'D').trim().replace(/\s+/g, ' ').toUpperCase() ?? null;
const trimmed = (value: string | null) => value?.trim() || null;

/** Exact claim matching only. Forged images can match; settlement must use a bank-source path. */
export function assessReceiptClaim(expected: ReceiptExpectedFacts, fields: ReceiptClaimFields, assessedAt = new Date()): ReceiptAssessment {
  const normalized: ReceiptClaimFields = { ...fields, bankBin: trimmed(fields.bankBin), accountNumber: trimmed(fields.accountNumber),
    beneficiaryName: normalizeName(fields.beneficiaryName), amountMinor: trimmed(fields.amountMinor),
    transferContent: trimmed(fields.transferContent)?.toUpperCase() ?? null, transactionId: trimmed(fields.transactionId)?.toUpperCase() ?? null };
  const warnings = ['CUSTOMER_IMAGE_NOT_BANK_PROOF'];
  if (normalized.bankBin !== expected.bankBin) warnings.push('BANK_MISMATCH');
  if (normalized.accountNumber !== expected.accountNumber) warnings.push('ACCOUNT_MISMATCH');
  if (normalized.beneficiaryName !== normalizeName(expected.beneficiaryName)) warnings.push('BENEFICIARY_MISMATCH');
  if (!normalized.amountMinor || !/^[1-9]\d{0,14}$/.test(normalized.amountMinor)
      || normalized.amountMinor !== expected.amountMinor) warnings.push('AMOUNT_MISMATCH');
  if (normalized.transferContent !== expected.transferContent) warnings.push('CONTENT_MISMATCH');
  // Never guess the time zone of an OCR value. The parser must supply explicit bank-local offset.
  const timestamp = parseReceiptTimestamp(fields.occurredAt);
  if (!timestamp || !Number.isFinite(timestamp.getTime()) || timestamp < expected.createdAt || timestamp >= expected.expiresAt || !Number.isFinite(assessedAt.getTime()) || timestamp > assessedAt) {
    normalized.occurredAt = null; warnings.push('TIME_MISMATCH');
  } else normalized.occurredAt = timestamp.toISOString();
  if (!normalized.transactionId) warnings.push('TRANSACTION_ID_MISSING');
  else if (!/^[A-Z0-9._:-]{1,100}$/.test(normalized.transactionId)) warnings.push('TRANSACTION_ID_INVALID');
  return { status: warnings.some((warning) => !['CUSTOMER_IMAGE_NOT_BANK_PROOF', 'TRANSACTION_ID_MISSING'].includes(warning))
    ? 'REVIEW_REQUIRED' : 'MATCHED_CLAIM', financialProof: false, warnings, normalized };
}

function parseReceiptTimestamp(value: string | null): Date | null {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offset] = parts;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(year) < 2000 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > lastDay
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
      || (offset.slice(1, 3) === '14' && offset.slice(4) !== '00')) return null;
  const timestamp = new Date(value!);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}
