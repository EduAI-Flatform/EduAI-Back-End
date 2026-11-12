import { GdsRevenueWalletService } from './gds-revenue-wallet.service';

function setup() {
  const projection = { id: 'projection', periodId: 'period', walletId: 'wallet', reviewRequired: false, appliedNetMinor: 0n, historicalPaidMinor: 0n, revision: 0 };
  const wallet = { id: 'wallet', buyerId: 'seller', debtMinor: 50000n, availableMinor: 0n, heldMinor: 50000n };
  const recognized = { kind: 'recognized', amountMinor: 75000n, createdAt: new Date('2026-11-04T02:00:00Z') };
  const settings = { processingEnabled: true, revenueCutoffAt: new Date('2026-11-04T01:00:00Z') };
  const tx = {
    $queryRaw: jest.fn(),
    revenueEarningPeriod: { findUniqueOrThrow: jest.fn().mockImplementation(async () => ({ id: 'period', sellerId: 'seller', entries: [recognized] })) },
    gdsWithdrawalSettings: { findUniqueOrThrow: jest.fn().mockResolvedValue(settings) },
    gdsInternalWallet: { createMany: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue(wallet) },
    gdsRevenueProjection: { findUnique: jest.fn().mockResolvedValue(projection), create: jest.fn().mockImplementation(async ({ data }) => ({ ...projection, ...data })) },
    gdsRevenueEffect: { create: jest.fn().mockImplementation(async ({ data }) => {
      projection.appliedNetMinor += data.deltaMinor; projection.revision += 1;
      wallet.availableMinor += data.availableDeltaMinor; wallet.debtMinor += data.debtDeltaMinor;
      return data;
    }) },
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
    gdsWithdrawalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    revenueEarningPeriod: { findMany: jest.fn().mockResolvedValue([{ id: 'period' }]) },
    affiliateIdentity: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const finance = { reconcileWalletPeriod: jest.fn().mockResolvedValue(true) };
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const affiliate = { syncOwner: jest.fn() };
  return { tx, prisma, finance, affiliate, settings, projection, wallet, recognized, service: new GdsRevenueWalletService(prisma as never, config as never, finance as never, affiliate as never) };
}
describe('recoverable revenue-to-GDS worker', () => {
  it('repays debt first and does not credit recognized earnings twice on worker replay', async () => {
    const { service, wallet, tx } = setup();
    await service.runBatch(); await service.runBatch();
    expect(wallet).toMatchObject({ debtMinor: 0n, availableMinor: 25000n, heldMinor: 50000n });
    expect(tx.gdsRevenueEffect.create).toHaveBeenCalledTimes(1);
  });
  it('records refund debt without taking held money, then recovers on retry', async () => {
    const { service, wallet, recognized, projection, finance, tx } = setup();
    projection.appliedNetMinor = 100000n; recognized.amountMinor = 0n;
    wallet.availableMinor = 20000n; wallet.debtMinor = 0n;
    finance.reconcileWalletPeriod.mockResolvedValueOnce(false);
    await service.runBatch();
    expect(tx.gdsRevenueEffect.create).not.toHaveBeenCalled();
    await service.runBatch();
    expect(wallet).toMatchObject({ availableMinor: 0n, debtMinor: 80000n, heldMinor: 50000n });
  });
  it('does not auto-credit historical periods until payout reconciliation is approved', async () => {
    const { service, tx, recognized } = setup();
    recognized.createdAt = new Date('2026-11-03T00:00:00Z');
    tx.gdsRevenueProjection.findUnique.mockResolvedValue(null);
    await service.runBatch();
    expect(tx.gdsRevenueProjection.create.mock.calls[0][0].data.reviewRequired).toBe(true);
    expect(tx.gdsRevenueEffect.create).not.toHaveBeenCalled();
  });
  it('does not process when paused and retries raw adapter serialization conflicts', async () => {
    const { service, prisma, settings, wallet } = setup();
    settings.processingEnabled = false;
    await service.runBatch(); expect(prisma.revenueEarningPeriod.findMany).not.toHaveBeenCalled();
    settings.processingEnabled = true;
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2010', meta: { code: '40001' } });
    await service.runBatch();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(wallet.availableMinor).toBe(25000n);
  });
});
