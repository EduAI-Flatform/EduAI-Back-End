import { bankQrPreviewReceiver, bankTransferEnabled, createVietQrPayload, classifyBankEvidence } from './bank-transfer-policy';

describe('manual VietQR safety policy', () => {
  it('fails closed in production even with an enabling flag', () => {
    expect(bankTransferEnabled('production', 'true')).toBe(false);
    expect(bankTransferEnabled('development', undefined)).toBe(false);
    expect(bankTransferEnabled('test', 'true')).toBe(true);
  });
  it('validates isolated Admin bank preview without enabling production checkout', () => {
    expect(bankQrPreviewReceiver({})).toBeNull();
    const env = { BANK_TRANSFER_PREVIEW_ENABLED: 'true', BANK_TRANSFER_RECEIVER_BANK_NAME: 'Example Bank', BANK_TRANSFER_RECEIVER_BANK_BIN: '123456',
      BANK_TRANSFER_RECEIVER_ACCOUNT_NUMBER: '1234567890', BANK_TRANSFER_RECEIVER_NAME: 'EXAMPLE TEST BENEFICIARY' };
    expect(bankQrPreviewReceiver(env)).toEqual({ bankName: 'Example Bank', bankBin: '123456',
      accountNumber: '1234567890', beneficiaryName: 'EXAMPLE TEST BENEFICIARY' });
    expect(bankQrPreviewReceiver({ ...env, BANK_TRANSFER_RECEIVER_BANK_NAME: 'Vietcombank', BANK_TRANSFER_RECEIVER_BANK_BIN: '970436' })?.bankBin).toBe('970436');
    expect(() => bankQrPreviewReceiver({ ...env, BANK_TRANSFER_RECEIVER_BANK_BIN: '97043X' })).toThrow();
    expect(() => bankQrPreviewReceiver({ ...env, BANK_TRANSFER_RECEIVER_BANK_NAME: '' })).toThrow();
    expect(() => bankQrPreviewReceiver({ ...env, BANK_TRANSFER_RECEIVER_ACCOUNT_NUMBER: '0000000000' })).toThrow();
    expect(() => bankQrPreviewReceiver({ ...env, BANK_TRANSFER_RECEIVER_NAME: 'fake\nline' })).toThrow();
    expect(bankTransferEnabled('production', 'true')).toBe(false);
  });
  it('encodes exact integer VND, bank account and unique reference', () => {
    const value = createVietQrPayload('970422', '0000000000', 125000n, 'EDUAI0123456789');
    expect(value).toContain('5406125000');
    expect(value).toContain('0000000000');
    expect(value).toContain('EDUAI0123456789');
    expect(value).toMatch(/6304[0-9A-F]{4}$/);
    // Fixed TLV vector; CRC A56A independently calculated by GF(2) long division
    // with polynomial 0x11021 and initial register 0xFFFF (not the encoder loop).
    expect(value).toBe('00020101021238540010A00000072701240006970422011000000000000208QRIBFTTA530370454061250005802VN62190815EDUAI01234567896304A56A');
    expect(() => createVietQrPayload('970422', '0000000000', 0n, 'BAD')).toThrow();
  });
  it('rejects every unmatched or late statement fact', () => {
    const request = { bankBin: '970422', accountNumber: '0000000000', amountMinor: 100n,
      transferContent: 'EDUAI1', createdAt: new Date('2026-10-22T00:00:00Z'), expiresAt: new Date('2026-10-22T00:15:00Z') };
    const evidence = { ...request, occurredAt: new Date('2026-10-22T00:05:00Z') };
    expect(classifyBankEvidence(request, evidence)).toBe(null);
    expect(classifyBankEvidence(request, { ...evidence, amountMinor: 99n })).toBe('UNDERPAID');
    expect(classifyBankEvidence(request, { ...evidence, amountMinor: 101n })).toBe('OVERPAID');
    expect(classifyBankEvidence(request, { ...evidence, accountNumber: '1111111111' })).toBe('ACCOUNT_MISMATCH');
    expect(classifyBankEvidence(request, { ...evidence, transferContent: 'OTHER' })).toBe('CONTENT_MISMATCH');
    expect(classifyBankEvidence(request, { ...evidence, occurredAt: request.expiresAt })).toBe('LATE_TRANSFER');
    expect(classifyBankEvidence(request, { ...evidence, occurredAt: new Date('2026-10-21') })).toBe('TIME_MISMATCH');
  });
});
