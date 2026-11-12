import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}
function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('Invalid authenticator secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
/** RFC6238 TOTP using SHA-1, 30-second steps and six digits for authenticator interoperability. */
export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}
export function matchTotpStep(secret: string, code: string, now: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0 || (lastUsedStep !== null && step <= lastUsedStep)) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) matched = step;
  }
  return matched;
}
export function encryptMfaSecret(secret: string, key: Buffer, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('gds-mfa:' + userId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}
export function decryptMfaSecret(value: string, key: Buffer, userId: string): string {
  const pieces = value.split('.');
  if (pieces.length !== 3) throw new Error('Invalid encrypted authenticator secret.');
  const [iv, tag, data] = pieces.map(piece => Buffer.from(piece, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('gds-mfa:' + userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
export function recoveryDigest(userId: string, code: string): string {
  return createHash('sha256').update('gds-mfa-recovery:' + userId + ':' + code.trim().toUpperCase()).digest('hex');
}
export function createRecoveryCodes(userId: string) {
  const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').toUpperCase().match(/.{1,6}/g)!.join('-'));
  return { codes, hashes: codes.map(code => recoveryDigest(userId, code)) };
}
