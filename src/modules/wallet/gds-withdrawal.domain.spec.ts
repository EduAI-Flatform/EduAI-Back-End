import { validateWithdrawalAmount, nextWithdrawalStatus } from './gds-withdrawal.domain';

describe('GDS withdrawal policy', () => {
  it.each(['50000', '10000000'])('accepts inclusive configured boundary %s', amount => {
    expect(validateWithdrawalAmount(amount, 50000n, 10000000n, 10000000n)).toBe(BigInt(amount));
  });
  it.each(['0', '-1', '1.2', '050000', '49999', '10000001'])('rejects invalid or out of range amount %s', amount => {
    expect(() => validateWithdrawalAmount(amount, 50000n, 10000000n, 10000000n)).toThrow();
  });
  it('rejects more than spendable funds', () => {
    expect(() => validateWithdrawalAmount('50000', 50000n, 10000000n, 49999n)).toThrow();
  });
  it('does not release a transfer with unknown outcome', () => {
    expect(() => nextWithdrawalStatus('PROCESSING', 'cancel')).toThrow();
    expect(() => nextWithdrawalStatus('PROCESSING', 'reject')).toThrow();
    expect(nextWithdrawalStatus('PROCESSING', 'fail')).toBe('FAILED');
  });
  it('only permits cancellation while pending and never pays twice', () => {
    expect(nextWithdrawalStatus('PENDING', 'cancel')).toBe('CANCELLED');
    expect(() => nextWithdrawalStatus('APPROVED', 'cancel')).toThrow();
    expect(() => nextWithdrawalStatus('PAID', 'pay')).toThrow();
  });
});
