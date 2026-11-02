import { GdsWalletService } from './gds-wallet.service';

const buyerId = 'test-buyer';
const config = {
  app: { nodeEnv: 'test', deploymentClass: 'uat' },
  gdsWallet: { sandboxEnabled: false },
};

describe('GDS wallet learner API projection', () => {
  const db = { buyerWalletLink: { findUnique: jest.fn() } };
  const service = new GdsWalletService(db as never, config as never);
  beforeEach(() => { db.buyerWalletLink.findUnique.mockReset(); config.gdsWallet.sandboxEnabled = false; });

  it('never queries or exposes money in production, even with a true flag', async () => {
    config.gdsWallet.sandboxEnabled = true;
    config.app.nodeEnv = 'production';
    expect(await service.summary(buyerId)).toMatchObject({ available: false, mode: 'disabled', balance: null, paymentEnabled: false, topupEnabled: false });
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
    config.app.nodeEnv = 'test';
    config.app.deploymentClass = 'production';
    expect((await service.summary(buyerId)).available).toBe(false);
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
    config.app.deploymentClass = 'uat';
  });

  it('defaults OFF and never invents funds without a real link', async () => {
    expect((await service.summary(buyerId)).state).toBe('UNAVAILABLE');
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
    config.gdsWallet.sandboxEnabled = true;
    db.buyerWalletLink.findUnique.mockResolvedValue(null);
    expect(await service.summary(buyerId)).toMatchObject({ state: 'NOT_LINKED', balance: null, topupEnabled: false });
  });

  it('projects immutable verified facts as strings and never enables payment', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.buyerWalletLink.findUnique.mockResolvedValue({
      status: 'linked',
      verifiedEvents: [{ kind: 'FUNDS_CREDITED', amountMinor: 100_000n, currency: 'VND', providerEventId: 'event-1', providerTransactionId: 'tx-1' }],
      reservations: [{ orderId: 'order-1', providerReservationId: 'reserve-1', amountMinor: 30_000n, status: 'UNKNOWN' }],
    });
    expect(await service.summary(buyerId)).toMatchObject({
      available: true, mode: 'sandbox', state: 'READY_SANDBOX',
      balance: { settledMinor: '100000', reservedMinor: '30000', availableMinor: '70000', currency: 'VND' },
      paymentEnabled: false, topupEnabled: false,
    });
  });

  it('fails closed when the verified mirror is inconsistent', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.buyerWalletLink.findUnique.mockResolvedValue({
      status: 'linked',
      verifiedEvents: [{ kind: 'PAYMENT_CAPTURED', amountMinor: 100n, currency: 'VND', providerEventId: 'event-2', providerTransactionId: 'tx-2' }],
      reservations: [],
    });
    expect(await service.summary(buyerId)).toMatchObject({ available: false, state: 'RECONCILIATION_REQUIRED', balance: null });
  });
});
