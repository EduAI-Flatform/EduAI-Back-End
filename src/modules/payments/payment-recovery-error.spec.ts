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

  it('extracts only safe nested DriverAdapterError cause fields', () => {
    class DriverAdapterError extends Error {
      cause = {
        kind: 'postgres',
        code: '23514',
        originalCode: '23514',
        originalMessage: 'constraint failed with account 123456789',
        message: 'secret database details',
        constraint: { fields: ['sensitive_field'] },
      };
    }

    const error = new PaymentRecoveryError(
      'fulfillment',
      'PAYMENT_RECOVERY_INTERNAL_ERROR',
      true,
      true,
      'settlement-id',
      new DriverAdapterError('adapter error'),
    );

    expect(error.diagnostic).toEqual({
      causeClass: 'DriverAdapterError',
      databaseCode: '23514',
      driverKind: 'postgres',
      category: 'database',
    });
    expect(error.message).toContain('cause=DriverAdapterError');
    expect(error.message).toContain('db=23514');
    expect(error.message).toContain('driver=postgres');
    expect(error.message).not.toContain('123456789');
    expect(error.message).not.toContain('sensitive_field');
    expect(JSON.stringify(error.diagnostic)).not.toContain('originalMessage');
  });

  it('extracts a safe adapter kind without copying unique constraint details', () => {
    class DriverAdapterError extends Error {
      cause = {
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['email', 'accountNumber'] },
      };
    }

    const error = new PaymentRecoveryError(
      'fulfillment',
      'PAYMENT_FULFILLMENT_FAILED',
      true,
      true,
      'settlement-id',
      new DriverAdapterError('duplicate sensitive value'),
    );

    expect(error.diagnostic).toEqual({
      causeClass: 'DriverAdapterError',
      driverKind: 'UniqueConstraintViolation',
      category: 'application',
    });
    expect(error.message).toContain('driver=UniqueConstraintViolation');
    expect(error.message).not.toContain('email');
    expect(error.message).not.toContain('accountNumber');
    expect(error.message).not.toContain('duplicate sensitive value');
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
