import { isTransactionWriteConflict } from './transaction-conflict';

describe('Prisma transaction write conflicts', () => {
  it.each([
    { code: 'P2034' },
    { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2039', meta: { driverAdapterError: { cause: { originalCode: '40001' } } } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } },
    Object.assign(new Error('TransactionWriteConflict'), { name: 'DriverAdapterError', cause: { kind: 'TransactionWriteConflict' } }),
  ])('recognizes a known serialization conflict %#', error => expect(isTransactionWriteConflict(error)).toBe(true));
  it.each([null, 'failure', { code: 'P2002' }, { code: 'P2028' },
    { code: 'P2010', meta: { code: '23514' } },
    { name: 'DriverAdapterError', cause: { kind: 'AuthenticationFailed' } }, new Error('invariant'),
  ])('does not widen serialization retries to other failures %#', error => expect(isTransactionWriteConflict(error)).toBe(false));
});
