import { GdsWalletService } from './gds-wallet.service';

const buyerId = 'test-buyer';
const config = {
  app: { nodeEnv: 'test', deploymentClass: 'uat' },
  gdsWallet: { sandboxEnabled: false },
};

describe('GDS wallet learner API projection', () => {
  const db = { gdsInternalWallet: { findUnique: jest.fn() }, gdsInternalJournal: { findMany: jest.fn() }, buyerWalletLink: { findUnique: jest.fn() } };
  const service = new GdsWalletService(db as never, config as never);
  beforeEach(() => { db.gdsInternalWallet.findUnique.mockReset(); db.gdsInternalJournal.findMany.mockReset().mockResolvedValue([]); db.buyerWalletLink.findUnique.mockReset(); config.gdsWallet.sandboxEnabled = false; });

  it('never queries or exposes money in production, even with a true flag', async () => {
    config.gdsWallet.sandboxEnabled = true;
    config.app.nodeEnv = 'production';
    expect(await service.summary(buyerId)).toMatchObject({ available: false, mode: 'disabled', balance: null, paymentEnabled: false, topupEnabled: false });
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
    expect(db.gdsInternalJournal.findMany).not.toHaveBeenCalled();
    config.app.nodeEnv = 'test';
    config.app.deploymentClass = 'production';
    expect((await service.summary(buyerId)).available).toBe(false);
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
    expect(db.gdsInternalJournal.findMany).not.toHaveBeenCalled();
    config.app.deploymentClass = 'uat';
  });

  it('defaults OFF and never invents funds without an initialized internal wallet', async () => {
    expect((await service.summary(buyerId)).state).toBe('UNAVAILABLE');
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue(null);
    expect(await service.summary(buyerId)).toMatchObject({ state: 'NOT_INITIALIZED', balance: null, topupEnabled: false });
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
    expect(db.gdsInternalJournal.findMany).not.toHaveBeenCalled();
  });

  it('projects internal account balances as strings and never enables payment', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({
      id: 'wallet-1', status: 'ACTIVE', availableMinor: 70_000n, heldMinor: 30_000n,
    });
    expect(await service.summary(buyerId)).toMatchObject({
      available: true, mode: 'sandbox', state: 'READY_SANDBOX',
      balance: { settledMinor: '100000', reservedMinor: '30000', availableMinor: '70000', currency: 'VND' },
      paymentEnabled: false, topupEnabled: false,
      recentTransactions: [],
    });
    expect(db.gdsInternalJournal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { walletId: 'wallet-1' }, take: 20,
      select: { id: true, kind: true, amountMinor: true, occurredAt: true },
    }));
  });

  it('returns only bounded journal history, without exposing bank or buyer identities', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({
      id: 'wallet-1', status: 'ACTIVE', availableMinor: 100_000n, heldMinor: 0n,
    });
    db.gdsInternalJournal.findMany.mockResolvedValue([{
      id: 'journal-1', kind: 'TOPUP_CREDIT', amountMinor: 100_000n,
      occurredAt: new Date('2026-11-02T12:00:00.000Z'),
      collectionReference: 'private-bank-transfer',
    }]);
    const result = await service.summary(buyerId);
    expect(result.recentTransactions).toEqual([{
      id: 'journal-1', type: 'TOPUP_CREDIT', amountMinor: '100000',
      occurredAt: '2026-11-02T12:00:00.000Z',
    }]);
    expect(JSON.stringify(result)).not.toContain('private-bank-transfer');
  });

  it('fails closed on an unknown or malformed journal posting', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({
      id: 'wallet-1', status: 'ACTIVE', availableMinor: 100_000n, heldMinor: 0n,
    });
    db.gdsInternalJournal.findMany.mockResolvedValue([{
      id: 'journal-unknown', kind: 'UNVERIFIED_ADJUSTMENT', amountMinor: 1n, occurredAt: new Date(),
    }]);
    expect(await service.summary(buyerId)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED', available: false, balance: null, recentTransactions: [],
    });
  });

  it('fails closed when the internal balance projection is inconsistent', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({ status: 'ACTIVE', availableMinor: -100n, heldMinor: 0n });
    expect(await service.summary(buyerId)).toMatchObject({ available: false, state: 'RECONCILIATION_REQUIRED', balance: null });
  });

  it('hides the internal balance of a suspended wallet', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({ status: 'SUSPENDED', availableMinor: 100_000n, heldMinor: 0n });
    expect(await service.summary(buyerId)).toMatchObject({ available: false, state: 'SUSPENDED', balance: null, paymentEnabled: false, topupEnabled: false });
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
  });
});
