import { GdsInternalTopupPreparationService, PrepareGdsTopup } from './gds-internal-topup-preparation.service';
import { GDS_UNBOUND_RECEIVING_ACCOUNT_HASH } from './gds-payos-topup.domain';

const buyerId = '11111111-1111-4111-8111-111111111111';
const walletId = '22222222-2222-4222-8222-222222222222';
const input: PrepareGdsTopup = {
  buyerId, amountMinor: 100_000n, idempotencyKey: 'gds-topup-20261102',
  expiresAt: new Date(Date.now() + 3_600_000),
  urls: {
    returnUrl: 'https://eduai.giaoducso.org.vn/wallet/gds?result=returned',
    cancelUrl: 'https://eduai.giaoducso.org.vn/wallet/gds?result=cancelled',
  },
};

describe('GDS PayOS internal topup intent preparation (not a QR or money-write endpoint)', () => {
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' },
    gdsWallet: { sandboxEnabled: true }, commerce: { idempotencySecret: 's'.repeat(32) } };
  const tx = {
    $queryRaw: jest.fn(),
    gdsInternalTopup: { findUnique: jest.fn(), create: jest.fn() },
    gdsInternalWallet: { upsert: jest.fn() },
    commercePaymentAttempt: { findFirst: jest.fn() },
    buyerWalletPayosTopup: { findFirst: jest.fn() },
  };
  const db = { $transaction: jest.fn() };
  const service = new GdsInternalTopupPreparationService(db as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.gdsWallet.sandboxEnabled = true; config.app.nodeEnv = 'test'; config.app.deploymentClass = 'uat';
    tx.$queryRaw.mockResolvedValue([{}]);
    tx.gdsInternalTopup.findUnique.mockResolvedValue(null);
    tx.gdsInternalTopup.create.mockResolvedValue({ id: 'stored' });
    tx.gdsInternalWallet.upsert.mockResolvedValue({ id: walletId, buyerId, status: 'ACTIVE' });
    tx.commercePaymentAttempt.findFirst.mockResolvedValue(null);
    tx.buyerWalletPayosTopup.findFirst.mockResolvedValue(null);
    db.$transaction.mockImplementation((action: (client: typeof tx) => Promise<unknown>) => action(tx));
  });

  it.each([
    ['feature disabled', 'test', 'uat', false],
    ['production node', 'production', 'uat', true],
    ['production deployment', 'test', 'production', true],
  ])('refuses %s before any DB access', async (_label, nodeEnv, deploymentClass, enabled) => {
    config.app.nodeEnv = nodeEnv; config.app.deploymentClass = deploymentClass;
    config.gdsWallet.sandboxEnabled = enabled;
    await expect(service.prepare(input)).rejects.toThrow('GDS topup preparation is unavailable');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid buyer', { buyerId: 'untrusted' }],
    ['non-integer VND', { amountMinor: 0n }],
    ['negative amount', { amountMinor: -1n }],
    ['unsafe amount', { amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['short idempotency', { idempotencyKey: 'short' }],
  ])('rejects %s before touching the DB', async (_label, patch) => {
    await expect(service.prepare({ ...input, ...patch })).rejects.toThrow('GDS_TOPUP_PREPARATION_INVALID_INPUT');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('persists one exact 1:1 VND intent with a bounded PayOS memo and no QR/provider request', async () => {
    const { intent, payosRequest } = await service.prepare(input);
    expect(intent).toMatchObject({ buyerId, amountMinor: 100_000n, status: 'CREATED',
      paymentLinkId: null, collectionReference: null });
    expect(payosRequest).toMatchObject({ amount: 100_000,
      returnUrl: input.urls.returnUrl, cancelUrl: input.urls.cancelUrl });
    expect(payosRequest?.orderCode).toBeGreaterThan(0);
    expect(payosRequest?.orderCode).toBeLessThan(36 ** 8);
    expect(payosRequest?.description).toMatch(/^G[A-Z0-9]{8}$/);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }));
    expect(tx.gdsInternalTopup.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      walletId, buyerId, requestKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      amountMinor: 100_000n, currency: 'VND', transferMemo: payosRequest?.description,
      payosOrderCode: intent.payosOrderCode, receivingAccountHash: GDS_UNBOUND_RECEIVING_ACCOUNT_HASH,
    }) });
  });

  it('reuses the same signed idempotent request, but rejects changed money facts', async () => {
    const first = await service.prepare(input);
    const data = tx.gdsInternalTopup.create.mock.calls[0][0].data;
    tx.gdsInternalTopup.findUnique.mockImplementation(({ where }) =>
      where.buyerId_requestKeyHash ? {
        ...first.intent, requestKeyHash: data.requestKeyHash,
      } : null);
    const retry = await service.prepare(input);
    expect(retry.intent.payosOrderCode).toBe(first.intent.payosOrderCode);
    expect(tx.gdsInternalTopup.create).toHaveBeenCalledTimes(1);
    const refreshedExpiry = await service.prepare({ ...input, expiresAt: new Date(input.expiresAt.getTime() + 15 * 60_000) });
    expect(refreshedExpiry.payosRequest?.expiredAt).toBe(first.payosRequest?.expiredAt);
    await expect(service.prepare({ ...input, amountMinor: 100_001n }))
      .rejects.toThrow('GDS_TOPUP_IDEMPOTENCY_CONFLICT');
    expect(tx.gdsInternalTopup.create).toHaveBeenCalledTimes(1);
  });

  it('never generates a second PayOS SDK request for an already pending link', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({
      ...input, id: 'existing-intent', currency: 'VND',
      receivingAccountHash: 'a'.repeat(64),
      payosOrderCode: 90_001n, status: 'PENDING_PAYOS', paymentLinkId: 'existing-link',
      collectionReference: null,
    });
    expect((await service.prepare(input)).payosRequest).toBeNull();
    expect(tx.gdsInternalTopup.create).not.toHaveBeenCalled();
  });

  it('rejects a reused PayOS code claimed by Commerce or the earlier partner model', async () => {
    tx.commercePaymentAttempt.findFirst.mockResolvedValue({ id: 'existing-commerce' });
    await expect(service.prepare(input)).rejects.toThrow('GDS_TOPUP_ORDER_CODE_EXHAUSTED');
    expect(tx.commercePaymentAttempt.findFirst).toHaveBeenCalledTimes(5);
    expect(tx.gdsInternalTopup.create).not.toHaveBeenCalled();

    tx.commercePaymentAttempt.findFirst.mockResolvedValue(null);
    tx.buyerWalletPayosTopup.findFirst.mockResolvedValue({ id: 'old-wallet-claim' });
    await expect(service.prepare(input)).rejects.toThrow('GDS_TOPUP_ORDER_CODE_EXHAUSTED');
    expect(tx.gdsInternalTopup.create).not.toHaveBeenCalled();
  });

  it('rejects suspended wallets and unsafe redirect URLs with no persisted intent', async () => {
    tx.gdsInternalWallet.upsert.mockResolvedValue({ id: walletId, status: 'SUSPENDED' });
    await expect(service.prepare(input)).rejects.toThrow('GDS_TOPUP_WALLET_SUSPENDED');
    tx.gdsInternalWallet.upsert.mockResolvedValue({ id: walletId, status: 'ACTIVE' });
    await expect(service.prepare({ ...input, urls: {
      returnUrl: 'http://redirect.example.com', cancelUrl: input.urls.cancelUrl,
    } })).rejects.toThrow('WALLET_TOPUP_UNTRUSTED_REDIRECT');
    expect(tx.gdsInternalTopup.create).not.toHaveBeenCalled();
  });
});
