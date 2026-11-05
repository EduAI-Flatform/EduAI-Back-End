import { GdsWalletService } from './gds-wallet.service';

const buyerId = 'test-buyer';
const config = {
  app: { nodeEnv: 'test', deploymentClass: 'uat', publicAppUrl: 'https://uat.example.org' },
  gdsWallet: { sandboxEnabled: false, checkoutEnabled: false, qrPreviewEnabled: false },
  payos: { environment: 'production' },
  commerce: { idempotencySecret: 'test-secret' },
};

describe('GDS wallet learner API projection', () => {
  const db = { gdsInternalWallet: { findUnique: jest.fn(), createMany: jest.fn(), findUniqueOrThrow: jest.fn() }, gdsInternalJournal: { findMany: jest.fn() }, buyerWalletLink: { findUnique: jest.fn() } };
  const service = new GdsWalletService(db as never, config as never);
  beforeEach(() => { db.gdsInternalWallet.findUnique.mockReset(); db.gdsInternalWallet.createMany.mockReset().mockResolvedValue({count:1}); db.gdsInternalWallet.findUniqueOrThrow.mockReset().mockResolvedValue({id:"zero-wallet",status:"ACTIVE",availableMinor:0n,heldMinor:0n}); db.gdsInternalJournal.findMany.mockReset().mockResolvedValue([]); db.buyerWalletLink.findUnique.mockReset(); config.gdsWallet.sandboxEnabled = false; config.gdsWallet.checkoutEnabled = false; config.gdsWallet.qrPreviewEnabled = false; });

  it('enables UAT PayOS topup when the provider is configured without a bank-account env key', async () => {
    config.gdsWallet.sandboxEnabled = true;
    config.gdsWallet.qrPreviewEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue(null);
    expect(await service.summary(buyerId)).toMatchObject({ state: 'READY_SANDBOX', topupEnabled: true });
    config.payos.environment = 'disabled';
    expect(await service.summary(buyerId)).toMatchObject({ topupEnabled: false });
    config.payos.environment = 'production';
  });

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

  it('reads production history with admission off and reports READY_PRODUCTION', async () => {
    const production = { app: { nodeEnv: 'production', deploymentClass: 'production', publicAppUrl: 'https://eduai.example.org' }, gdsWallet: { sandboxEnabled: false, productionTopupEnabled: false, productionCheckoutEnabled: false }, payos: { environment: 'production', clientId: 'client', apiKey: 'key', checksumKey: 'checksum', webhookUrl: 'https://api.eduai.example.org/api/v1/payments/webhooks/payos' }, commerce: { idempotencySecret: 'x'.repeat(32) } };
    const productionService = new GdsWalletService(db as never, production as never);
    db.gdsInternalWallet.findUnique.mockResolvedValue({ id: 'wallet-production', status: 'ACTIVE', availableMinor: 2000n, heldMinor: 0n });
    expect(await productionService.summary(buyerId)).toMatchObject({ available: true, mode: 'production', state: 'READY_PRODUCTION', paymentEnabled: false, topupEnabled: false, balance: {availableMinor: '2000'} });
    production.gdsWallet.productionCheckoutEnabled = true;
    expect(await productionService.summary(buyerId)).toMatchObject({ paymentEnabled: true, topupEnabled: false });
    production.gdsWallet.productionTopupEnabled = true;
    expect(await productionService.summary(buyerId)).toMatchObject({ paymentEnabled: true, topupEnabled: true });
    db.gdsInternalWallet.findUnique.mockResolvedValue({ id: 'wallet-production', status: 'SUSPENDED', availableMinor: 2000n, heldMinor: 0n });
    expect(await productionService.summary(buyerId)).toMatchObject({ state: 'SUSPENDED', topupEnabled: false, paymentEnabled: false });
    db.gdsInternalWallet.findUnique.mockResolvedValue({ id: 'wallet-production', status: 'ACTIVE', availableMinor: -1n, heldMinor: 0n });
    expect(await productionService.summary(buyerId)).toMatchObject({ state: 'RECONCILIATION_REQUIRED', topupEnabled: false, paymentEnabled: false });
    db.gdsInternalWallet.findUnique.mockResolvedValue(null);
    expect(await productionService.summary(buyerId)).toMatchObject({ mode: 'production', state: 'READY_PRODUCTION', balance: {availableMinor:'0'}, topupEnabled: true });
  });

  it('defaults OFF and never invents funds without an initialized internal wallet', async () => {
    expect((await service.summary(buyerId)).state).toBe('UNAVAILABLE');
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue(null);
    expect(await service.summary(buyerId)).toMatchObject({ state: 'READY_SANDBOX', balance: {availableMinor:'0'}, topupEnabled: false });
    expect(db.buyerWalletLink.findUnique).not.toHaveBeenCalled();
    expect(db.gdsInternalWallet.createMany).toHaveBeenCalledWith({data:[{buyerId}],skipDuplicates:true});
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
      select: { id: true, kind: true, amountMinor: true, occurredAt: true, orderRef: true },
    }));
  });

  it('reports GDS checkout ready only for an active UAT wallet with the separate checkout flag', async () => {
    config.gdsWallet.sandboxEnabled = true;
    config.gdsWallet.checkoutEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({
      id: 'wallet-1', status: 'ACTIVE', availableMinor: 100_000n, heldMinor: 0n,
    });
    expect(await service.summary(buyerId)).toMatchObject({ paymentEnabled: true, state: 'READY_SANDBOX' });
    config.app.deploymentClass = 'production';
    expect(await service.summary(buyerId)).toMatchObject({ paymentEnabled: false, available: false });
    config.app.deploymentClass = 'uat';
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

  it('links withdrawal postings to one request without exposing other order references', async () => {
    config.gdsWallet.sandboxEnabled = true;
    db.gdsInternalWallet.findUnique.mockResolvedValue({ id: 'wallet-1', status: 'ACTIVE', availableMinor: 100000n, heldMinor: 0n });
    const requestId = '10000000-0000-4000-8000-000000000001';
    const kinds = ['WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAID', 'RESERVE', 'TOPUP_CREDIT'];
    db.gdsInternalJournal.findMany.mockResolvedValue(kinds.map((kind, index) => ({
      id: `journal-${index}`, kind, amountMinor: 10000n, occurredAt: new Date('2026-11-05T01:00:00Z'),
      orderRef: kind.startsWith('WITHDRAWAL_') ? requestId : '20000000-0000-4000-8000-000000000002',
    })));
    const result = await service.summary(buyerId);
    expect(result.recentTransactions.slice(0, 3).map(entry => entry.withdrawalId)).toEqual([requestId, requestId, requestId]);
    expect(result.recentTransactions.slice(3).every(entry => !('withdrawalId' in entry))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('20000000-0000-4000-8000-000000000002');
    expect(JSON.stringify(result)).not.toContain('orderRef');
    expect(db.gdsInternalJournal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { walletId: 'wallet-1' }, take: 20, select: expect.objectContaining({ orderRef: true }),
    }));
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


describe('zero wallet initialization',()=>{
 it('creates an absent wallet without posting money, and never updates a funded wallet',async()=>{
 const db={gdsInternalWallet:{findUnique:jest.fn().mockResolvedValueOnce(null).mockResolvedValue({id:'wallet',status:'ACTIVE',availableMinor:5000n,heldMinor:0n}),createMany:jest.fn().mockResolvedValue({count:1}),findUniqueOrThrow:jest.fn().mockResolvedValue({id:'wallet',status:'ACTIVE',availableMinor:0n,heldMinor:0n})},gdsInternalJournal:{findMany:jest.fn().mockResolvedValue([])}};
 const c={...config,app:{...config.app,nodeEnv:'test',deploymentClass:'uat'},gdsWallet:{sandboxEnabled:true}};const service=new GdsWalletService(db as never,c as never);
 expect((await service.summary(buyerId)).balance?.availableMinor).toBe('0');
 expect((await service.summary(buyerId)).balance?.availableMinor).toBe('5000');
 expect(db.gdsInternalWallet.createMany).toHaveBeenCalledTimes(1);expect(db.gdsInternalWallet.createMany).toHaveBeenCalledWith({data:[{buyerId}],skipDuplicates:true});
 });
});
