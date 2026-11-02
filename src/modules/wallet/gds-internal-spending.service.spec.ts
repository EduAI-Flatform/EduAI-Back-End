import { CommerceOrderStatus } from '../../../generated/prisma/client';
import { GdsInternalSpendingService } from './gds-internal-spending.service';

const buyerId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const walletId = '33333333-3333-4333-8333-333333333333';

describe('GDS sandbox internal Commerce holds (no HTTP and no capture/entitlement)', () => {
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const order = () => ({ buyerId, status: CommerceOrderStatus.pending_payment,
    payableAmountMinor: 70_000n, currency: 'VND' });
  const wallet = () => ({ id: walletId, buyerId, status: 'ACTIVE',
    availableMinor: 100_000n, heldMinor: 0n });
  const tx = {
    $queryRaw: jest.fn(),
    commerceOrder: { findUnique: jest.fn() },
    commercePaymentAttempt: { findFirst: jest.fn() },
    commerceSettlement: { findFirst: jest.fn() },
    gdsInternalWallet: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    gdsInternalHold: { findUnique: jest.fn() },
    gdsInternalJournal: { create: jest.fn() },
  };
  const db = { $transaction: jest.fn() };
  const service = new GdsInternalSpendingService(db as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.app.nodeEnv = 'test'; config.app.deploymentClass = 'uat';
    config.gdsWallet.sandboxEnabled = true;
    tx.$queryRaw.mockResolvedValue([{ id: orderId }]);
    tx.commerceOrder.findUnique.mockResolvedValue(order());
    tx.commercePaymentAttempt.findFirst.mockResolvedValue(null);
    tx.commerceSettlement.findFirst.mockResolvedValue(null);
    tx.gdsInternalWallet.findUnique.mockResolvedValue(wallet());
    tx.gdsInternalWallet.findUniqueOrThrow.mockResolvedValue({ ...wallet(),
      availableMinor: 30_000n, heldMinor: 70_000n });
    tx.gdsInternalHold.findUnique.mockResolvedValue(null);
    tx.gdsInternalJournal.create.mockResolvedValue({ id: 'posting-id' });
    db.$transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  });

  it.each([
    ['feature disabled', 'test', 'uat', false],
    ['production runtime', 'production', 'uat', true],
    ['production deployment class', 'test', 'production', true],
  ])('refuses %s before any DB use', async (_label, nodeEnv, deploymentClass, enabled) => {
    config.app.nodeEnv = nodeEnv; config.app.deploymentClass = deploymentClass;
    config.gdsWallet.sandboxEnabled = enabled;
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS internal spending is unavailable');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid buyer/order identifiers before hitting SQL', async () => {
    await expect(service.reserveForUnpaidCommerceOrder('wrong', orderId))
      .rejects.toThrow('GDS_HOLD_INVALID_IDENTITY');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('reserves exact VND under a serializable row lock and balanced journal posting', async () => {
    expect(await service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .toEqual({ availableMinor: '30000', heldMinor: '70000', currency: 'VND' });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.gdsInternalJournal.create).toHaveBeenCalledWith({ data: {
      walletId, eventKey: `gds:reserve:${orderId}`, kind: 'RESERVE',
      amountMinor: 70_000n, availableDeltaMinor: -70_000n,
      heldDeltaMinor: 70_000n, clearingDeltaMinor: 0n, orderRef: orderId,
    } });
  });

  it('idempotently returns an existing matching reservation but refuses terminal replay', async () => {
    tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId, amountMinor: 70_000n, status: 'RESERVED' });
    expect(await service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .toMatchObject({ availableMinor: '30000', heldMinor: '70000' });
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
    tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId, amountMinor: 70_000n, status: 'CAPTURED' });
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_TERMINAL_OR_MISMATCH');
  });

  it.each([
    ['wrong buyer', { buyerId: '44444444-4444-4444-8444-444444444444' }],
    ['confirmed order', { status: CommerceOrderStatus.confirmed }],
    ['zero payable', { payableAmountMinor: 0n }],
    ['foreign currency', { currency: 'USD' }],
  ])('rejects %s without moving funds', async (_label, patch) => {
    tx.commerceOrder.findUnique.mockResolvedValue({ ...order(), ...patch });
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_ORDER_NOT_PAYABLE');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it.each([
    ['existing provider attempt', 'commercePaymentAttempt'],
    ['existing settlement', 'commerceSettlement'],
  ] as const)('rejects %s even if the provider payment is no longer pending', async (_label, table) => {
    tx[table].findFirst.mockResolvedValue({ id: 'already-charged' });
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_PAYMENT_METHOD_CONFLICT');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('refuses insufficient available balance and suspended wallets', async () => {
    tx.gdsInternalWallet.findUnique.mockResolvedValue({ ...wallet(), availableMinor: 69_999n });
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_INSUFFICIENT_FUNDS');
    tx.gdsInternalWallet.findUnique.mockResolvedValue({ ...wallet(), status: 'SUSPENDED' });
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_WALLET_UNAVAILABLE');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('does not release on pending, confirmed or unknown payment status', async () => {
    tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId, amountMinor: 70_000n, status: 'RESERVED' });
    await expect(service.releaseForFinalUnpaidOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_ORDER_NOT_FINAL_UNPAID');
    tx.commerceOrder.findUnique.mockResolvedValue({ ...order(), status: CommerceOrderStatus.cancelled });
    tx.commercePaymentAttempt.findFirst.mockResolvedValue({ id: 'ambiguous-payment' });
    await expect(service.releaseForFinalUnpaidOrder(buyerId, orderId))
      .rejects.toThrow('GDS_HOLD_PAYMENT_STATUS_AMBIGUOUS');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('releases a definitively cancelled unpaid order once and is replay-safe', async () => {
    tx.commerceOrder.findUnique.mockResolvedValue({ ...order(), status: CommerceOrderStatus.cancelled });
    tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId, amountMinor: 70_000n, status: 'RESERVED' });
    tx.gdsInternalWallet.findUniqueOrThrow.mockResolvedValue({ ...wallet() });
    expect(await service.releaseForFinalUnpaidOrder(buyerId, orderId))
      .toEqual({ availableMinor: '100000', heldMinor: '0', currency: 'VND' });
    expect(tx.gdsInternalJournal.create).toHaveBeenCalledWith({ data: {
      walletId, eventKey: `gds:release:${orderId}`, kind: 'RELEASE',
      amountMinor: 70_000n, availableDeltaMinor: 70_000n,
      heldDeltaMinor: -70_000n, clearingDeltaMinor: 0n, orderRef: orderId,
    } });
    tx.gdsInternalHold.findUnique.mockResolvedValue({ walletId, amountMinor: 70_000n, status: 'RELEASED' });
    tx.gdsInternalJournal.create.mockClear();
    await service.releaseForFinalUnpaidOrder(buyerId, orderId);
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('retries serialization conflicts but never ignores negative-balance failures', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await service.reserveForUnpaidCommerceOrder(buyerId, orderId);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockRejectedValueOnce(new Error('gds_internal_wallets_nonnegative_check'));
    await expect(service.reserveForUnpaidCommerceOrder(buyerId, orderId))
      .rejects.toThrow('gds_internal_wallets_nonnegative_check');
  });
});
