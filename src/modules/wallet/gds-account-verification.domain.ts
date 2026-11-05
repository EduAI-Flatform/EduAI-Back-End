export function normalizeBankAccountName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'D').toUpperCase().replace(/\s+/g, ' ').trim();
}
export function sameBankAccountName(left: string, right: string): boolean {
  const a = normalizeBankAccountName(left), b = normalizeBankAccountName(right);
  return a.length > 0 && a === b;
}
export function verificationMatches(record: { ownerId: string; bankCode: string; accountNumber: string; expiresAt: Date; purpose: string; withdrawalId: string | null }, ownerId: string, bankCode: string, accountNumber: string, now = new Date()): boolean {
  return record.purpose === 'CREATE' && record.withdrawalId === null && record.ownerId === ownerId && record.bankCode === bankCode && record.accountNumber === accountNumber && record.expiresAt > now;
}
