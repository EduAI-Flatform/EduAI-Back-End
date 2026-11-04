import { isRetryableGdsTransaction } from './gds-transaction-retry';
describe('Prisma PostgreSQL transaction retry classification', () => {
  it.each([
    { code: 'P2034' }, { code: 'P2002' },
    { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2039', meta: { driverAdapterError: { cause: { originalCode: '40001' } } } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } },
    { name: 'DriverAdapterError', cause: { kind: 'TransactionWriteConflict' } },
  ])('retries known transient failures %j', error => expect(isRetryableGdsTransaction(error)).toBe(true));
  it.each([null, 'failure', { code: 'P2010', meta: { code: '23514' } }, new Error('invariant')])('never retries invariant violations %j', error => expect(isRetryableGdsTransaction(error)).toBe(false));
});
