import { receiptEarlyAccessEnabled } from '../../common/security/receipt-sandbox-policy';
import { receiptSandboxEnabled, assessReceiptClaim } from './bank-transfer-receipt-policy';

describe('receipt claim trust boundary', () => {
  const actor = '11111111-1111-4111-8111-111111111111';
  const env = { BANK_TRANSFER_SANDBOX_ENABLED: 'true', BANK_RECEIPT_SANDBOX_ENABLED: 'true',
    BANK_RECEIPT_SYNTHETIC_BUYER_IDS: actor };
  const order = { bankBin: '970422', accountNumber: '0000000000', beneficiaryName: 'EDUAI SANDBOX',
    amountMinor: '100000', transferContent: 'EDUAI123456', createdAt: new Date('2026-10-23T01:00:00Z'),
    expiresAt: new Date('2026-10-23T01:15:00Z') };
  const claim = { bankBin: '970422', accountNumber: '0000000000', beneficiaryName: 'EduAI Sandbox',
    amountMinor: '100000', transferContent: 'EDUAI123456', occurredAt: '2026-10-23T08:05:00+07:00', transactionId: 'SYNTHETIC-TX-001' };
  it.each(['production', 'staging', '', 'unknown'])('denies %s even with flags and an allowed identity', (runtime) => {
    expect(receiptSandboxEnabled(runtime, env, actor)).toBe(false);
  });
  it('requires explicit opt-in and a synthetic identity', () => {
    expect(receiptSandboxEnabled('test', env, actor)).toBe(true);
    expect(receiptSandboxEnabled('development', env, actor)).toBe(true);
    expect(receiptSandboxEnabled('test', {}, actor)).toBe(false);
    expect(receiptSandboxEnabled('test', env, 'other')).toBe(false);
    expect(receiptSandboxEnabled('test', { ...env, BANK_TRANSFER_SANDBOX_ENABLED: 'false' }, actor)).toBe(false);
    expect(receiptSandboxEnabled('test', { ...env, BANK_RECEIPT_SANDBOX_ENABLED: 'false' }, actor)).toBe(false);
  });
  it('matches a claim without asserting paid or bank-source verification', () => {
    expect(assessReceiptClaim(order, claim)).toEqual({ status: 'MATCHED_CLAIM', warnings: ['CUSTOMER_IMAGE_NOT_BANK_PROOF'],
      financialProof: false, normalized: { ...claim, beneficiaryName: 'EDUAI SANDBOX', occurredAt: '2026-10-23T01:05:00.000Z' } });
  });
  it.each([
    ['bankBin', '970436', 'BANK_MISMATCH'], ['accountNumber', '1111111111', 'ACCOUNT_MISMATCH'],
    ['beneficiaryName', 'DIFFERENT PERSON', 'BENEFICIARY_MISMATCH'], ['amountMinor', '99999', 'AMOUNT_MISMATCH'],
    ['amountMinor', '100000.00', 'AMOUNT_MISMATCH'], ['amountMinor', '1e5', 'AMOUNT_MISMATCH'],
    ['transferContent', 'EDUAI1234567', 'CONTENT_MISMATCH'], ['transferContent', 'EDUAI123456 OTHER', 'CONTENT_MISMATCH'],
    ['occurredAt', '2026-10-23T01:15:00Z', 'TIME_MISMATCH'], ['occurredAt', '2026-10-23T01:05:00', 'TIME_MISMATCH'],
    ['occurredAt', 'nonsense', 'TIME_MISMATCH'], ['transactionId', '<script>', 'TRANSACTION_ID_INVALID'],
  ])('requires review for %s=%s', (field, value, warning) => {
    const result = assessReceiptClaim(order, { ...claim, [field]: value });
    expect(result.status).toBe('REVIEW_REQUIRED'); expect(result.warnings).toContain(warning);
    expect(result.financialProof).toBe(false);
  });
  it('permits an absent optional bank transaction code but reports it', () => {
    const result = assessReceiptClaim(order, { ...claim, transactionId: null });
    expect(result.status).toBe('MATCHED_CLAIM'); expect(result.warnings).toContain('TRANSACTION_ID_MISSING');
  });
  it('does not remove reference punctuation or guess incomplete OCR fields', () => {
    const result = assessReceiptClaim(order, { ...claim, transferContent: 'EDUAI-123456', accountNumber: null });
    expect(result.status).toBe('REVIEW_REQUIRED'); expect(result.warnings).toEqual(expect.arrayContaining(['CONTENT_MISMATCH','ACCOUNT_MISMATCH']));
  });
});

describe('strict OCR timestamp and Vietnamese payee handling', () => {
  const expected = { bankBin: '970422', accountNumber: '0000000000', beneficiaryName: '\u0110\u1eb7ng \u0110\u1ee9c',
    amountMinor: '100000', transferContent: 'EDUAI123456', createdAt: new Date('2026-03-02T01:00:00Z'), expiresAt: new Date('2026-03-02T01:15:00Z') };
  const claim = { ...expected, beneficiaryName: 'DANG DUC', occurredAt: '2026-03-02T08:05:00+07:00', transactionId: null };
  const now = new Date('2026-03-02T01:10:00Z');
  it('matches folded Vietnamese payee names', () => {
    expect(assessReceiptClaim(expected, claim, now).status).toBe('MATCHED_CLAIM');
  });
  it.each(['2026-02-30T08:05:00+07:00', '2026-03-02T08:05:00+14:30', '2026-03-02T08:05:00+07:00 trailing'])('rejects impossible/invalid ISO dates: %s', (occurredAt) => {
    expect(assessReceiptClaim(expected, { ...claim, occurredAt }, now).warnings).toContain('TIME_MISMATCH');
  });
  it('rejects future claims even within the order window', () => {
    expect(assessReceiptClaim(expected, { ...claim, occurredAt: '2026-03-02T01:11:00Z' }, now).status).toBe('REVIEW_REQUIRED');
  });
});

describe('full unverified receipt capability',()=>{
  const buyer='11111111-1111-4111-8111-111111111111';
  const flags={BANK_TRANSFER_SANDBOX_ENABLED:'true',BANK_RECEIPT_SANDBOX_ENABLED:'true',BANK_RECEIPT_SYNTHETIC_BUYER_IDS:buyer,BANK_RECEIPT_EARLY_ACCESS_ENABLED:'true'};
  it('requires every synthetic guard plus the separate early-access opt-in',()=>{
    expect(receiptEarlyAccessEnabled('test',flags,buyer)).toBe(true);
    expect(receiptEarlyAccessEnabled('test',{...flags,BANK_RECEIPT_EARLY_ACCESS_ENABLED:'false'},buyer)).toBe(false);
    expect(receiptEarlyAccessEnabled('test',flags,'other')).toBe(false);
    expect(receiptEarlyAccessEnabled('development',{...flags,BANK_RECEIPT_SANDBOX_ENABLED:'false'},buyer)).toBe(false);
  });
  it.each(['production','staging','unknown'])('cannot enable full early access in %s',runtime=>{
    expect(receiptEarlyAccessEnabled(runtime,flags,buyer)).toBe(false);
  });
});