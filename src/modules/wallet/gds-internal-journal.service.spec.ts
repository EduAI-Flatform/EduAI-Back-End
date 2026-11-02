import { GdsInternalJournalService } from './gds-internal-journal.service';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { GdsInternalPayosSettlement } from './gds-internal-topup.domain';

const intent: GdsPayosTopupIntent = {
  id: 'sandbox-topup-id', buyerId: 'sandbox-buyer', amountMinor: 100_000n,
  currency: 'VND', payosOrderCode: 900_000_123_456n, receivingAccountHash: 'a'.repeat(64),
  expiresAt: new Date('2026-11-02T16:00:00Z'), status: 'PAYOS_VERIFIED',
  paymentLinkId: 'sandbox-link', collectionReference: 'sandbox-collection', partnerCreditEventId: null,
};
const settlement: GdsInternalPayosSettlement = {
  orderCode: intent.payosOrderCode, paymentLinkId: 'sandbox-link',
  amountMinor: 100_000n, amountRemainingMinor: 0n, currency: 'VND',
  receivingAccountHash: intent.receivingAccountHash, collectionReference: 'sandbox-collection',
  status: 'PAID', signatureVerifiedAt: new Date('2026-11-02T12:00:00Z'),
  providerReconciledAt: new Date('2026-11-02T12:02:00Z'),
};

describe('GDS internal journal boundary (not an HTTP or live PayOS adapter)', () => {
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const persistedTopup = () => ({
    id: intent.id, buyerId: intent.buyerId, walletId: 'internal-wallet',
    amountMinor: intent.amountMinor, currency: intent.currency,
    payosOrderCode: intent.payosOrderCode, paymentLinkId: intent.paymentLinkId,
    receivingAccountHash: intent.receivingAccountHash,
    collectionReference: intent.collectionReference, status: 'PAYOS_VERIFIED',
    signatureVerifiedAt: settlement.signatureVerifiedAt,
    providerReconciledAt: settlement.providerReconciledAt,
  });
  const internalWallet = () => ({
    id: 'internal-wallet', buyerId: intent.buyerId, status: 'ACTIVE',
    availableMinor: 100_000n, heldMinor: 0n,
  });
  const tx = {
    gdsInternalTopup: { findUnique: jest.fn() },
    gdsInternalWallet: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    gdsInternalJournal: { findUnique: jest.fn(), create: jest.fn() },
    commercePaymentAttempt: { findFirst: jest.fn() },
    commercePaymentEvent: { findFirst: jest.fn() },
    commerceSettlement: { findFirst: jest.fn() },
    buyerWalletPayosTopup: { findFirst: jest.fn() },
  };
  const db = { $transaction: jest.fn() };
  const service = new GdsInternalJournalService(db as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.app.nodeEnv = 'test'; config.app.deploymentClass = 'uat'; config.gdsWallet.sandboxEnabled = true;
    tx.gdsInternalTopup.findUnique.mockResolvedValue(persistedTopup());
    tx.gdsInternalWallet.findUnique.mockResolvedValue(internalWallet());
    tx.gdsInternalWallet.findUniqueOrThrow.mockResolvedValue(internalWallet());
    tx.gdsInternalJournal.findUnique.mockResolvedValue(null);
    tx.gdsInternalJournal.create.mockResolvedValue({ id: 'journal-id' });
    tx.commercePaymentAttempt.findFirst.mockResolvedValue(null);
    tx.commercePaymentEvent.findFirst.mockResolvedValue(null);
    tx.commerceSettlement.findFirst.mockResolvedValue(null);
    tx.buyerWalletPayosTopup.findFirst.mockResolvedValue(null);
    db.$transaction.mockImplementation((action: (transaction: typeof tx) => Promise<unknown>) => action(tx));
  });

  it.each([
    ['disabled flag', { sandboxEnabled: false, nodeEnv: 'test', deploymentClass: 'uat' }],
    ['production NODE_ENV', { sandboxEnabled: true, nodeEnv: 'production', deploymentClass: 'uat' }],
    ['production deployment class', { sandboxEnabled: true, nodeEnv: 'test', deploymentClass: 'production' }],
  ])('refuses %s before touching the DB', async (_name, value) => {
    config.gdsWallet.sandboxEnabled = value.sandboxEnabled;
    config.app.nodeEnv = value.nodeEnv; config.app.deploymentClass = value.deploymentClass;
    await expect(service.creditVerifiedTopup(intent, settlement)).rejects.toThrow('GDS internal prepayment is unavailable');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects browser-only QR, underpayments or unreconciled facts before touching the DB', async () => {
    await expect(service.creditVerifiedTopup({ ...intent, status: 'PENDING_PAYOS' }, settlement)).rejects.toThrow('GDS_INTERNAL_TOPUP_NOT_ELIGIBLE');
    await expect(service.creditVerifiedTopup(intent, { ...settlement, amountRemainingMinor: 1n })).rejects.toThrow('GDS_INTERNAL_TOPUP_PAYMENT_MISMATCH');
    await expect(service.creditVerifiedTopup(intent, { ...settlement, signatureVerifiedAt: new Date(Number.NaN) })).rejects.toThrow('GDS_INTERNAL_TOPUP_NOT_RECONCILED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('inserts an exact balanced 100000 VND journal posting in a serializable transaction', async () => {
    expect(await service.creditVerifiedTopup(intent, settlement)).toEqual({ availableMinor: '100000', heldMinor: '0', currency: 'VND' });
    expect(tx.gdsInternalJournal.create).toHaveBeenCalledWith({ data: {
      walletId: 'internal-wallet', eventKey: 'payos-gds-topup:900000123456',
      kind: 'TOPUP_CREDIT', amountMinor: 100_000n, availableDeltaMinor: 100_000n,
      heldDeltaMinor: 0n, clearingDeltaMinor: -100_000n,
      topupId: intent.id, collectionReference: intent.collectionReference,
    } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'Serializable' }));
  });

  it('returns an identical already-credited event without inserting a second posting', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...persistedTopup(), status: 'CREDITED' });
    tx.gdsInternalJournal.findUnique.mockResolvedValue({
      eventKey: 'payos-gds-topup:900000123456', walletId: 'internal-wallet',
      kind: 'TOPUP_CREDIT', topupId: intent.id, amountMinor: 100_000n,
      collectionReference: intent.collectionReference,
    });
    expect(await service.creditVerifiedTopup(intent, settlement)).toMatchObject({ availableMinor: '100000' });
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('fails closed on cross-buyer intent and colliding event identities', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({ ...persistedTopup(), buyerId: 'different-buyer' });
    await expect(service.creditVerifiedTopup(intent, settlement)).rejects.toThrow('GDS_INTERNAL_TOPUP_DB_MISMATCH');
    tx.gdsInternalTopup.findUnique.mockResolvedValue(persistedTopup());
    tx.gdsInternalJournal.findUnique.mockResolvedValue({
      eventKey: 'payos-gds-topup:900000123456', walletId: 'internal-wallet',
      kind: 'TOPUP_CREDIT', topupId: 'different-topup', amountMinor: 100_000n,
      collectionReference: intent.collectionReference,
    });
    await expect(service.creditVerifiedTopup(intent, settlement)).rejects.toThrow('GDS_INTERNAL_TOPUP_EVENT_COLLISION');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it.each([
    ['Commerce PayOS attempt', 'commercePaymentAttempt'],
    ['Commerce webhook event', 'commercePaymentEvent'],
    ['Commerce settlement', 'commerceSettlement'],
    ['earlier partner-mirror topup', 'buyerWalletPayosTopup'],
  ] as const)('refuses an existing %s claim of the same PayOS money', async (_label, table) => {
    tx[table].findFirst.mockResolvedValue({ id: 'already-claimed' });
    await expect(service.creditVerifiedTopup(intent, settlement))
      .rejects.toThrow('GDS_INTERNAL_TOPUP_CROSS_LEDGER_COLLISION');
    expect(tx.gdsInternalJournal.create).not.toHaveBeenCalled();
  });

  it('requires persisted provider verification timestamps to match the caller fact', async () => {
    tx.gdsInternalTopup.findUnique.mockResolvedValue({
      ...persistedTopup(), providerReconciledAt: new Date('2026-11-02T12:03:00Z'),
    });
    await expect(service.creditVerifiedTopup(intent, settlement))
      .rejects.toThrow('GDS_INTERNAL_TOPUP_DB_MISMATCH');
    expect(tx.commercePaymentAttempt.findFirst).not.toHaveBeenCalled();
  });

  it('retries serialization collisions and never silently accepts conflicting facts', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    expect(await service.creditVerifiedTopup(intent, settlement)).toMatchObject({ availableMinor: '100000' });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockReset();
    db.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(service.creditVerifiedTopup(intent, settlement)).rejects.toThrow('GDS_INTERNAL_TOPUP_UNIQUE_COLLISION');
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
});
