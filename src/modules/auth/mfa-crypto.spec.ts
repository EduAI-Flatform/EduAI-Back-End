import { totpAt, encodeBase32, encryptMfaSecret, decryptMfaSecret, matchTotpStep } from './mfa-crypto';
describe('RFC6238 and secret storage', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890'));
  it.each([[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])('matches RFC test vector at %s', (seconds, code) => {
    expect(totpAt(secret, Math.floor(Number(seconds) / 30), 8)).toBe(code);
  });
  it('allows clock tolerance but rejects reused and malformed codes', () => {
    const step = Math.floor(1234567890 / 30);
    const code = totpAt(secret, step);
    expect(matchTotpStep(secret, code, step * 30000, step - 1)).toBe(step);
    expect(matchTotpStep(secret, code, step * 30000, step)).toBeNull();
    expect(matchTotpStep(secret, '123', step * 30000, null)).toBeNull();
  });
  it('encrypts with user-bound authenticated data and rejects tampering', () => {
    const key = Buffer.alloc(32, 1);
    const encrypted = encryptMfaSecret(secret, key, 'owner');
    expect(encrypted).not.toContain(secret);
    expect(decryptMfaSecret(encrypted, key, 'owner')).toBe(secret);
    expect(() => decryptMfaSecret(encrypted, key, 'other-user')).toThrow();
  });
});
