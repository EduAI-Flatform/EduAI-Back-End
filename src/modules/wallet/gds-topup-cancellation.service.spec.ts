import { GdsTopupCancellationService } from './gds-topup-cancellation.service';

const buyerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const topupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
describe('GDS authenticated unpaid PayOS cancellation', () => {
  let db: any, config: any, provider: any, registry: any, row: any, service: GdsTopupCancellationService;
  const facts = (status = 'PENDING') => ({
    providerPaymentIdentity: 'link-1', localOrderReference: 1234, amountMinor: 10000n,
    amountPaidMinor: 0n, amountRemainingMinor: 10000n, transactions: [], status,
  });
  beforeEach(() => {
    config = { app: { nodeEnv: 'test', deploymentClass: 'uat', publicAppUrl: 'https://uat.example.org' },
      gdsWallet: { sandboxEnabled: true, qrPreviewEnabled: true },
      payos: { environment: 'production' }, commerce: { idempotencySecret: 'unit-only' } };
    row = { id: topupId, buyerId, status: 'PENDING_PAYOS', paymentLinkId: 'link-1',
      payosOrderCode: 1234n, amountMinor: 10000n, currency: 'VND',
      collectionReference: null, signatureVerifiedAt: null, providerReconciledAt: null,
      creditedAt: null, settlementReceivingAccountHash: null, journal: null, reconciliation: null, payosInbox: [] };
    db = { gdsInternalTopup: {
      findFirst: jest.fn(async ({ where }) => where.buyerId === row.buyerId ? row : null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    }, $transaction: jest.fn(async (run) => run(db)) };
    provider = { retrievePaymentRequest: jest.fn().mockResolvedValue(facts()),
      cancelPaymentRequest: jest.fn().mockResolvedValue(facts('CANCELLED')) };
    registry = { requireEnabled: jest.fn(() => provider) };
    service = new GdsTopupCancellationService(db, config, registry);
  });
  it('checks ownership then authenticated unpaid facts before cancelling and conditionally persisting', async () => {
    expect(await service.cancel(buyerId, topupId)).toEqual({ topupId, status: 'CANCELLED', gdsCredited: false });
    expect(db.gdsInternalTopup.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: topupId, buyerId } }));
    expect(provider.retrievePaymentRequest).toHaveBeenCalledWith('link-1');
    expect(provider.cancelPaymentRequest).toHaveBeenCalledWith('link-1', 'Cancelled by learner');
    expect(db.gdsInternalTopup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: topupId, buyerId, status: 'PENDING_PAYOS',
        journal: { is: null }, reconciliation: { is: null }, payosInbox: { none: {} } }),
      data: { status: 'CANCELLED' },
    }));
  });
  it.each(['wallet', 'qr', 'runtime', 'deployment', 'provider'])('rejects disabled %s before any database or provider access', async (gate) => {
    if (gate === 'wallet') config.gdsWallet.sandboxEnabled = false;
    if (gate === 'qr') config.gdsWallet.qrPreviewEnabled = false;
    if (gate === 'runtime') config.app.nodeEnv = 'production';
    if (gate === 'deployment') config.app.deploymentClass = 'production';
    if (gate === 'provider') config.payos.environment = 'disabled';
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
    expect(db.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
    expect(registry.requireEnabled).not.toHaveBeenCalled();
  });
  it('does not disclose or cancel another buyer topup', async () => {
    row.buyerId = 'other-buyer';
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
    expect(provider.retrievePaymentRequest).not.toHaveBeenCalled();
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'PAID', amountPaidMinor: 10000n, amountRemainingMinor: 0n },
    { amountPaidMinor: 1n }, { providerPaymentIdentity: 'other-link' },
    { localOrderReference: 9999 }, { amountMinor: 9999n },
    { transactions: [{ reference: 'real-transfer' }] },
  ])('never cancels paid or mismatched preflight facts case %#', async (patch) => {
    provider.retrievePaymentRequest.mockResolvedValue({ ...facts(), ...patch });
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(db.gdsInternalTopup.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ status: 'PENDING' }, { amountPaidMinor: 1n }, { providerPaymentIdentity: 'other-link' }])(
    'does not persist cancellation for an unconfirmed or mismatched cancel result case %#', async (patch) => {
      provider.cancelPaymentRequest.mockResolvedValue({ ...facts('CANCELLED'), ...patch });
      await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
      expect(db.gdsInternalTopup.updateMany).not.toHaveBeenCalled();
    },
  );
  it('returns a sanitized failure and leaves state untouched when the provider is unavailable', async () => {
    provider.cancelPaymentRequest.mockRejectedValue(new Error('private-api-key'));
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow('GDS_TOPUP_CANCELLATION_UNAVAILABLE');
    expect(db.gdsInternalTopup.updateMany).not.toHaveBeenCalled();
  });
  it('rejects the local write when a signed webhook or reconciliation wins the race', async () => {
    db.gdsInternalTopup.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow('GDS_TOPUP_CANCELLATION_CONFLICT');
  });
  it.each(['payosInbox', 'journal', 'reconciliation'])('blocks cancellation with existing %s evidence', async (field) => {
    row[field] = field === 'payosInbox' ? [{ id: 'signed-event' }] : { id: 'proof' };
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
  });
  it('is idempotent for an already cancelled owned row without contacting PayOS', async () => {
    row.status = 'CANCELLED';
    expect(await service.cancel(buyerId, topupId)).toMatchObject({ status: 'CANCELLED', gdsCredited: false });
    expect(registry.requireEnabled).not.toHaveBeenCalled();
    expect(db.gdsInternalTopup.updateMany).not.toHaveBeenCalled();
  });
  it('recovers a verified remote cancellation after a prior local write failure without cancelling twice', async () => {
    provider.retrievePaymentRequest.mockResolvedValue(facts('CANCELLED'));
    expect(await service.cancel(buyerId, topupId)).toMatchObject({ status: 'CANCELLED' });
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(db.gdsInternalTopup.updateMany).toHaveBeenCalledTimes(1);
  });
  it('holds no transaction or row lock across the remote cancellation call', async () => {
    provider.cancelPaymentRequest.mockImplementation(async () => {
      expect(db.$transaction).not.toHaveBeenCalled();
      return facts('CANCELLED');
    });
    await service.cancel(buyerId, topupId);
  });
  it.each(['CREATED', 'PAYOS_VERIFIED', 'CREDITED', 'REVIEW'])('rejects local %s before contacting PayOS', async (status) => {
    row.status = status;
    await expect(service.cancel(buyerId, topupId)).rejects.toThrow();
    expect(registry.requireEnabled).not.toHaveBeenCalled();
  });
  it('rejects malformed ids before database access', async () => {
    await expect(service.cancel(buyerId, 'invalid')).rejects.toThrow();
    expect(db.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
  });
});
