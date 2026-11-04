import { BadRequestException, ConflictException } from '@nestjs/common';

export type WithdrawalAction = 'approve' | 'reject' | 'process' | 'pay' | 'fail' | 'cancel';
export const WITHDRAWAL_STATUSES = ['PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED', 'FAILED'] as const;
export function validateWithdrawalAmount(value: string, minimum: bigint, maximum: bigint, available: bigint): bigint {
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new BadRequestException('GDS_WITHDRAWAL_INVALID_AMOUNT');
  const amount = BigInt(value);
  if (minimum <= 0n || minimum > maximum || amount < minimum || amount > maximum) throw new BadRequestException('GDS_WITHDRAWAL_LIMIT');
  if (amount > available) throw new ConflictException('GDS_WITHDRAWAL_INSUFFICIENT_FUNDS');
  return amount;
}
export function nextWithdrawalStatus(status: string, action: WithdrawalAction): string {
  const transitions: Record<string, Partial<Record<WithdrawalAction, string>>> = {
    PENDING: { approve: 'APPROVED', reject: 'REJECTED', cancel: 'CANCELLED' },
    APPROVED: { process: 'PROCESSING', reject: 'REJECTED' },
    PROCESSING: { pay: 'PAID', fail: 'FAILED' },
  };
  const next = transitions[status]?.[action];
  if (!next) throw new ConflictException('GDS_WITHDRAWAL_INVALID_TRANSITION');
  return next;
}
