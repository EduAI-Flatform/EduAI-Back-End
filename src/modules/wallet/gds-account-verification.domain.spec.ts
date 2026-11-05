import { sameBankAccountName, verificationMatches } from './gds-account-verification.domain';
describe('bank recipient verification binding', () => {
  it('normalizes accents, case and whitespace, without fuzzy matching', () => {
    expect(sameBankAccountName('ĐẶNG  THỊ ÁNH', 'dang thi anh')).toBe(true);
    expect(sameBankAccountName('NGUYEN VAN A', 'NGUYEN VAN B')).toBe(false);
  });
  it('rejects expired or cross-owner/account verification', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    const record = { ownerId: 'owner', bankCode: 'TPB', accountNumber: '00123456', expiresAt: new Date(now.getTime()+900000), purpose: 'CREATE', withdrawalId: null };
    expect(verificationMatches(record, 'owner', 'TPB', '00123456', now)).toBe(true);
    expect(verificationMatches(record, 'other', 'TPB', '00123456', now)).toBe(false);
    expect(verificationMatches(record, 'owner', 'MB', '00123456', now)).toBe(false);
    expect(verificationMatches(record, 'owner', 'TPB', '123456', now)).toBe(false);
    expect(verificationMatches(record, 'owner', 'TPB', '00123456', record.expiresAt)).toBe(false);
  });
});
