import { GdsWalletService } from './gds-wallet.service';
import { RoleName } from '../../../generated/prisma/client';
import { GdsWalletController } from './gds-wallet.controller';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  app: { nodeEnv: 'test', deploymentClass: 'uat', publicAppUrl: 'https://uat.example.org' },
  gdsWallet: { sandboxEnabled: true }, payos: { environment: 'production' },
  commerce: { idempotencySecret: 'unit-only-secret' },
};

function setup() {
  const tx = {
    gdsInternalWallet: { findUnique: jest.fn().mockResolvedValue({ id: 'wallet', status: 'ACTIVE', availableMinor: 100000n, heldMinor: 60000n, debtMinor: 12000n }) },
    gdsInternalJournal: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([{ paymentHeldMinor: '20000', withdrawalHeldMinor: '40000', totalWithdrawnMinor: '250000' }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const db = { $transaction: jest.fn(async read => read(tx)) };
  const service = new GdsWalletService(db as never, config as never);
  return { tx, db, summary: (roles: RoleName[] = []) => (service.summary as any)(owner, undefined, roles) };
}

describe('GDS wallet reporting contract', () => {
  it('reads hold split, lifetime paid total, balance and debt in one consistent snapshot', async () => {
    const { summary, db } = setup();
    expect(await summary([RoleName.student])).toMatchObject({
      balance: { availableMinor: '100000', settledMinor: '160000', reservedMinor: '60000' },
      debtMinor: '12000', paymentHeldMinor: '20000', withdrawalHeldMinor: '40000', totalWithdrawnMinor: '250000', income: null,
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  it('shows net income for a multi-role instructor without equating it with wallet deposits or withdrawals', async () => {
    const { summary, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([{ paymentHeldMinor: '20000', withdrawalHeldMinor: '40000', totalWithdrawnMinor: '250000' }])
      .mockResolvedValueOnce([{ recognizedMinor: '190000', pendingMinor: '150000', reviewPendingMinor: '120000' }]);
    expect((await summary([RoleName.student, RoleName.instructor])).income).toEqual({
      status: 'READY', totalMinor: '340000', recognizedMinor: '190000', pendingMinor: '150000', reviewPendingMinor: '120000',
    });
  });

  it('keeps the usable wallet when income reporting fails, and never invents zero income', async () => {
    const { summary, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([{ paymentHeldMinor: '20000', withdrawalHeldMinor: '40000', totalWithdrawnMinor: '250000' }])
      .mockRejectedValueOnce(new Error('private database failure'));
    const result = await summary([RoleName.instructor]);
    expect(result.available).toBe(true);
    expect(result.income).toEqual({ status: 'UNAVAILABLE', totalMinor: null, recognizedMinor: null, pendingMinor: null, reviewPendingMinor: null });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(tx.$executeRaw.mock.calls.map(([query]) => query[0])).toEqual([
      'SAVEPOINT gds_income_summary', 'ROLLBACK TO SAVEPOINT gds_income_summary', 'RELEASE SAVEPOINT gds_income_summary',
    ]);
  });

  it('fails closed instead of presenting an inconsistent hold breakdown', async () => {
    const { summary, tx } = setup();
    tx.$queryRaw.mockResolvedValue([{ paymentHeldMinor: '1', withdrawalHeldMinor: '2', totalWithdrawnMinor: '0' }]);
    expect(await summary()).toMatchObject({ available: false, state: 'RECONCILIATION_REQUIRED', balance: null });
  });

  it('does not expose invalid negative income as a zero or an available balance', async () => {
    const { summary, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([{ paymentHeldMinor: '20000', withdrawalHeldMinor: '40000', totalWithdrawnMinor: '250000' }])
      .mockResolvedValueOnce([{ recognizedMinor: '-1', pendingMinor: '0', reviewPendingMinor: '0' }]);
    const result = await summary([RoleName.instructor]);
    expect(result.balance.availableMinor).toBe('100000');
    expect(result.income.status).toBe('UNAVAILABLE');
    expect(result.income.totalMinor).toBeNull();
  });

  it('passes only authenticated server roles into income eligibility', () => {
    const wallet = { summary: jest.fn() };
    const controller = new GdsWalletController(wallet as never, {} as never, {} as never, {} as never);
    (controller.summary as any)(owner, undefined, [RoleName.student, RoleName.instructor]);
    expect(wallet.summary).toHaveBeenCalledWith(owner, undefined, [RoleName.student, RoleName.instructor]);
  });

  it('retries a first-visit serialization conflict with a fresh complete snapshot', async () => {
    const { summary, db } = setup();
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    expect(await summary()).toMatchObject({ available: true, withdrawalHeldMinor: '40000' });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});
