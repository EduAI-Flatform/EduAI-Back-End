import { Prisma } from '../../../generated/prisma/client';
import { lockGdsPayosOrderNamespace } from './gds-payos-order-namespace';

describe('GDS PayOS order namespace mutex', () => {
  it('acquires the shared transaction-scoped lock without selecting PostgreSQL void', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ acquired: 1 }]);
    await lockGdsPayosOrderNamespace({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toBe(
      'SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(474453, 404)',
    );
  });
});
