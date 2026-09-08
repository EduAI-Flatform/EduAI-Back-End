import { PaymentRecoveryError } from './payment-recovery-error';

describe('PaymentRecoveryError', () => {
  it('retains only safe Prisma diagnostic metadata', () => {
    const cause = Object.assign(new Error('secret SQL should never be copied'), {
      code: 'P2034',
      meta: { accountNumber: '123456789', sql: 'select secret' },
    });

    const error = new PaymentRecoveryError(
      'fulfillment',
      'PAYMENT_TRANSACTION_RETRY_EXHAUSTED',
      true,
      true,
      'settlement-id',
      cause,
    );

    expect(error.diagnostic).toEqual({
      causeClass: 'Error',
      prismaCode: 'P2034',
      category: 'prisma',
    });
    expect(error.message).toContain('cause=Error');
    expect(error.message).toContain('prisma=P2034');
    expect(error.message).not.toContain('secret SQL');
    expect(error.message).not.toContain('123456789');
    expect(JSON.stringify(error.diagnostic)).not.toContain('accountNumber');
  });

  it('classifies safe database codes without retaining raw messages', () => {
    class DatabaseError extends Error {
      code = '23505';
    }
    const cause = new DatabaseError('duplicate row includes sensitive values');

    const error = new PaymentRecoveryError(
      'fulfillment',
      'PAYMENT_RECOVERY_INTERNAL_ERROR',
      true,
      true,
      'settlement-id',
      cause,
    );

    expect(error.diagnostic).toEqual({
      causeClass: 'DatabaseError',
      databaseCode: '23505',
      category: 'database',
    });
    expect(error.message).toContain('db=23505');
    expect(error.message).not.toContain('sensitive values');
  });

  it('does not expose arbitrary non-code fields from unknown objects', () => {
    const error = new PaymentRecoveryError(
      'fulfillment',
      'PAYMENT_FULFILLMENT_FAILED',
      true,
      true,
      'settlement-id',
      {
        message: 'Bearer token-that-must-not-leak',
        accountNumber: '987654321',
        payload: { checksumKey: 'secret' },
      },
    );

    expect(error.diagnostic).toEqual({
      causeClass: 'Object',
      category: 'unknown',
    });
    expect(error.message).not.toContain('Bearer');
    expect(error.message).not.toContain('987654321');
    expect(error.message).not.toContain('secret');
  });
});
