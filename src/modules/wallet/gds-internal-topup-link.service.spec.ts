import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreatedPaymentRequest } from '../payments/payment-provider';
import { GdsInternalTopupLinkService } from './gds-internal-topup-link.service';
import { GDS_UNBOUND_RECEIVING_ACCOUNT_HASH } from './gds-payos-topup.domain';

const topupId = '11111111-1111-4111-8111-111111111111';
const buyerId = '22222222-2222-4222-8222-222222222222';
const bankAccount = '1234567890';
const receivingHash = createHash('sha256').update(bankAccount).digest('hex');
const link: CreatedPaymentRequest = {
  providerPaymentIdentity: 'payos-link-id',
  providerOrderReference: '9000001234', localOrderReference: 9000001234,
  amountMinor: 100_000n, currency: 'VND', status: 'PENDING',
  checkoutUrl: 'https://pay.payos.vn/web/payos-link-id',
  qrPayload: '00020101021238570010A000000727', receivingAccount: bankAccount,
};

describe('GDS authenticated SDK link attachment (source-only, no public QR)', () => {
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const stored = () => ({ id: topupId, buyerId, amountMinor: 100_000n, currency: 'VND',
    payosOrderCode: 9_000_001_234n, receivingAccountHash: receivingHash,
    status: 'CREATED', expiresAt: new Date('2026-11-02T12:15:00Z'),
    paymentLinkId: null, collectionReference: null });
  const tx = {
    $queryRaw: jest.fn(),
    gdsInternalTopup: { findUnique: jest.fn(), update: jest.fn() },
    commercePaymentAttempt: { findFirst: jest.fn() },
    buyerWalletPayosTopup: { findFirst: jest.fn() },
  };
  const db = { $transaction: jest.fn() };
  const service = new GdsInternalTopupLinkService(db as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.app.nodeEnv = 'test'; config.app.deploymentClass = 'uat'; config.gdsWallet.sandboxEnabled = true;
    tx.$queryRaw.mockResolvedValue([{}]);
    tx.gdsInternalTopup.findUnique.mockResolvedValue(stored());
    tx.gdsInternalTopup.update.mockResolvedValue({});
    tx.commercePaymentAttempt.findFirst.mockResolvedValue(null);
    tx.buyerWalletPayosTopup.findFirst.mockResolvedValue(null);
    db.$transaction.mockImplementation((action: (client: typeof tx) => Promise<unknown>) => action(tx));
  });

  it.each([
    ['feature off', 'test', 'uat', false],
    ['prod NODE_ENV', 'production', 'uat', true],
    ['prod deployment class', 'test', 'production', true],
  ])('refuses %s before DB read', async (_label, env, deployment, flag) => {
    config.app.nodeEnv = env; config.app.deploymentClass = deployment; config.gdsWallet.sandboxEnabled = flag;
    await expect(service.attachCreatedLink(topupId, link))
      .rejects.toThrow('GDS PayOS link persistence is unavailable');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('attaches a normalized PayOS link once in a locked serializable transaction', async () => {
    expect(await service.attachCreatedLink(topupId, link)).toEqual({
      paymentLinkId: link.providerPaymentIdentity,
      checkoutUrl: link.checkoutUrl,
      qrPayload: link.qrPayload,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }));
    expect(tx.gdsInternalTopup.update).toHaveBeenCalledWith({
      where: { id: topupId },
      data: { status: 'PENDING_PAYOS', paymentLinkId: 'payos-link-id' },
    });
  });

  it('binds the PayOS API beneficiary for an unbound intent exactly once alongside the link', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...stored(), receivingAccountHash: GDS_UNBOUND_RECEIVING_ACCOUNT_HASH });
    await service.attachCreatedLink(topupId, link);
    expect(tx.gdsInternalTopup.update).toHaveBeenCalledWith({
      where: { id: topupId },
      data: { status: 'PENDING_PAYOS', paymentLinkId: link.providerPaymentIdentity, receivingAccountHash: receivingHash },
    });
  });

  it('rejects an attempt to change a previously linked PayOS beneficiary', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...stored(), status: 'PENDING_PAYOS', paymentLinkId: link.providerPaymentIdentity });
    await expect(service.attachCreatedLink(topupId, { ...link, receivingAccount: '9876543210' }))
      .rejects.toThrow('WALLET_TOPUP_PAYOS_MISMATCH');
    expect(tx.gdsInternalTopup.update).not.toHaveBeenCalled();
  });

  it('is idempotent for the identical already-attached link', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...stored(), status: 'PENDING_PAYOS', paymentLinkId: 'payos-link-id' });
    expect((await service.attachCreatedLink(topupId, link)).paymentLinkId).toBe('payos-link-id');
    expect(tx.gdsInternalTopup.update).not.toHaveBeenCalled();
  });

  it.each([
    ['different order code', { providerOrderReference: '9000001235' }],
    ['different price', { amountMinor: 99_999n }],
    ['different currency', { currency: 'USD' }],
    ['different actual beneficiary', { receivingAccount: '9876543210' }],
    ['untrusted checkout host', { checkoutUrl: 'https://evil.example/pay' }],
    ['different payment identity', { providerPaymentIdentity: 'another-link', checkoutUrl: 'https://pay.payos.vn/web/another-link' }],
  ])('refuses %s without journal credit or link mutation', async (_label, patch) => {
    if ('providerPaymentIdentity' in patch) {
      tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...stored(), status: 'PENDING_PAYOS', paymentLinkId: 'payos-link-id' });
    }
    await expect(service.attachCreatedLink(topupId, { ...link, ...patch } as CreatedPaymentRequest))
      .rejects.toThrow();
    expect(tx.gdsInternalTopup.update).not.toHaveBeenCalled();
  });

  it.each([
    ['Commerce PayOS attempt', 'commercePaymentAttempt'],
    ['prior wallet link', 'buyerWalletPayosTopup'],
  ] as const)('refuses a %s collision', async (_label, table) => {
    tx[table].findFirst.mockResolvedValue({ id: 'other-link-claim' });
    await expect(service.attachCreatedLink(topupId, link))
      .rejects.toThrow('GDS_TOPUP_CROSS_LEDGER_LINK_COLLISION');
    expect(tx.gdsInternalTopup.update).not.toHaveBeenCalled();
  });

  it('rejects malformed SDK facts before touching DB', async () => {
    await expect(service.attachCreatedLink(topupId, { ...link, status: 'PAID' }))
      .rejects.toThrow('GDS_TOPUP_INVALID_PAYOS_LINK');
    await expect(service.attachCreatedLink(topupId, { ...link, receivingAccount: 'bad account' }))
      .rejects.toThrow('GDS_TOPUP_INVALID_PAYOS_LINK');
    await expect(service.attachCreatedLink('bad-id', link)).rejects.toThrow('GDS_TOPUP_INVALID_PAYOS_LINK');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('logs only fixed diagnostic reasons and omits sensitive SDK fields', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await expect(service.attachCreatedLink(topupId, {
        ...link, status: 'PAID', receivingAccount: 'sensitive account', qrPayload: 'sensitive-qr'.repeat(1000),
      })).rejects.toThrow('GDS_TOPUP_INVALID_PAYOS_LINK');
      expect(warn).toHaveBeenCalledWith({ event: 'gds_payos_link_rejected',
        issues: ['status_not_pending', 'invalid_receiving_account', 'invalid_qr_payload'] });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(link.providerPaymentIdentity);
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('retries serialization races and refuses unknown intents', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await service.attachCreatedLink(topupId, link);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    tx.gdsInternalTopup.findUnique.mockResolvedValue(null);
    await expect(service.attachCreatedLink(topupId, link)).rejects.toThrow('GDS_TOPUP_INTENT_NOT_FOUND');
  });
});

// Regression: PayOS virtual accounts are opaque authenticated identifiers.
describe('PayOS SDK beneficiary contract regression', () => {
  it('accepts an alphanumeric virtual account without changing its bytes', async () => {
    const account = 'VIRTUAL123456789012345678901234567890123';
    const tx = {
      $queryRaw: jest.fn(),
      gdsInternalTopup: {
        findUnique: jest.fn().mockResolvedValue({
          id: topupId, buyerId, amountMinor: link.amountMinor, currency: 'VND',
          payosOrderCode: BigInt(link.providerOrderReference),
          receivingAccountHash: GDS_UNBOUND_RECEIVING_ACCOUNT_HASH,
          status: 'CREATED', expiresAt: new Date('2027-01-01'),
          paymentLinkId: null, collectionReference: null,
        }), update: jest.fn(),
      },
      commercePaymentAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
      buyerWalletPayosTopup: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const db = { $transaction: jest.fn((action) => action(tx)) };
    const service = new GdsInternalTopupLinkService(db as never, {
      app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true },
    } as never);
    await expect(service.attachCreatedLink(topupId, { ...link, receivingAccount: account }))
      .resolves.toHaveProperty('paymentLinkId', link.providerPaymentIdentity);
    expect(tx.gdsInternalTopup.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ receivingAccountHash: createHash('sha256').update(account).digest('hex') }),
    }));
  });
});
