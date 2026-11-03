import { isPayosAccount, isPayosQr, payosLinkIssues } from './payos-link.validation';

describe('shared PayOS link validation', () => {
  it.each(['1234567890', 'VIRTUAL123456789012345678901234567890123', 'receiving-account'])(
    'preserves valid opaque account identifiers', (account) => expect(isPayosAccount(account)).toBe(true),
  );
  it.each([null, undefined, '', 'with space', 'line\nbreak', 'a'.repeat(129), 123456])(
    'rejects absent, malformed or unbounded account facts', (account) => expect(isPayosAccount(account)).toBe(false),
  );
  it('uses the same bounded QR contract beyond the previous GDS limit', () => {
    expect(isPayosQr('1'.repeat(4097))).toBe(true);
    expect(isPayosQr('1'.repeat(8192))).toBe(true);
    expect(isPayosQr('1'.repeat(8193))).toBe(false);
    expect(isPayosQr('')).toBe(false);
    expect(isPayosQr(null)).toBe(false);
  });
  it('reports only fixed reasons, with no SDK values', () => {
    const issues = payosLinkIssues({
      status: 'secret-status', receivingAccount: 'secret account',
      providerPaymentIdentity: 'secret/identity', qrPayload: undefined,
      checkoutUrl: 'https://evil.example/secret',
    });
    expect(issues).toEqual(['status_not_pending', 'invalid_receiving_account',
      'invalid_link_identity', 'invalid_qr_payload', 'untrusted_checkout_url']);
    expect(JSON.stringify(issues)).not.toContain('secret');
  });
});
