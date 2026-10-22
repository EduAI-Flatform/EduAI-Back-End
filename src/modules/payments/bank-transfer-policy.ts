import { BadRequestException } from '@nestjs/common';

// PAYW-01 never enables real collection: the only receiver is a synthetic UAT account.
export const BANK_SANDBOX_RECEIVER = Object.freeze({ bankName: 'MB Bank (SANDBOX)', bankBin: '970422',
  accountNumber: '0000000000', beneficiaryName: 'EDUAI SANDBOX - KHONG CHUYEN TIEN THAT' });

export function bankTransferEnabled(nodeEnv: string, flag: string | undefined): boolean {
  return (nodeEnv === 'development' || nodeEnv === 'test') && flag === 'true';
}

const tlv = (id: string, value: string) => `${id}${value.length.toString().padStart(2, '0')}${value}`;
export function createVietQrPayload(bankBin: string, account: string, amount: bigint, content: string): string {
  if (!/^\d{6}$/.test(bankBin) || !/^\d{6,19}$/.test(account) || amount <= 0n ||
      amount > BigInt(Number.MAX_SAFE_INTEGER) || !/^[A-Z0-9]{6,25}$/.test(content)) {
    throw new BadRequestException('Invalid VietQR facts.');
  }
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', bankBin) + tlv('01', account)) + tlv('02', 'QRIBFTTA');
  const value = tlv('00', '01') + tlv('01', '12') + tlv('38', merchant) + tlv('53', '704') +
    tlv('54', amount.toString()) + tlv('58', 'VN') + tlv('62', tlv('08', content)) + '6304';
  let crc = 0xffff;
  for (const byte of Buffer.from(value, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return value + crc.toString(16).toUpperCase().padStart(4, '0');
}

interface BankFacts { bankBin: string; accountNumber: string; amountMinor: bigint; transferContent: string }
export function classifyBankEvidence(request: BankFacts & { createdAt: Date; expiresAt: Date },
  evidence: BankFacts & { occurredAt: Date }): string | null {
  if (evidence.bankBin !== request.bankBin || evidence.accountNumber !== request.accountNumber) return 'ACCOUNT_MISMATCH';
  if (evidence.amountMinor < request.amountMinor) return 'UNDERPAID';
  if (evidence.amountMinor > request.amountMinor) return 'OVERPAID';
  if (evidence.transferContent !== request.transferContent) return 'CONTENT_MISMATCH';
  if (!Number.isFinite(evidence.occurredAt.getTime()) || evidence.occurredAt < request.createdAt || evidence.occurredAt > new Date()) return 'TIME_MISMATCH';
  if (evidence.occurredAt >= request.expiresAt) return 'LATE_TRANSFER';
  return null;
}
