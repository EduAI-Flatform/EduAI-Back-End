import { createHash } from 'node:crypto';
import { GdsPayosInboxService } from './gds-payos-inbox.service';
import { GdsInternalJournalService } from './gds-internal-journal.service';
import { PaymentProviderError, VerifiedPaymentWebhook } from '../payments/payment-provider';

const account = '123456789012';
const hash = createHash('sha256').update(account).digest('hex');
const buyerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const walletId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const topupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const orderCode = 40012345678n;
const amount = 85_000n;

type Row = Record<string, any>;

describe('PAYW-04E signed inbox → independent PayOS lookup → exactly-once GDS credit', () => {
  let topup: Row;
  let wallet: Row;
  let entries: Row[];
  let inbox: Row[];
  let config: Row;
  let tx: Row;
  let prisma: Row;
  let provider: Row;
  let service: GdsPayosInboxService;
  let event: VerifiedPaymentWebhook;

  beforeEach(() => {
    jest.clearAllMocks();
    const occurredAt = new Date(Date.now() - 20_000);
    event = {
      provider: 'payos', providerCode: '00', responseCode: '00',
      providerOrderReference: String(orderCode), localOrderReference: Number(orderCode),
      providerEventIdentity: 'bank-ref-001', providerSettlementReference: 'bank-ref-001',
      providerPaymentIdentity: 'payos-link-a', amountMinor: amount, currency: 'VND',
      receivingAccount: account, occurredAt,
    };
    topup = {
      id: topupId, buyerId, walletId, requestKeyHash: 'a'.repeat(64),
      payosOrderCode: orderCode, paymentLinkId: event.providerPaymentIdentity,
      amountMinor: amount, currency: 'VND', status: 'PENDING_PAYOS',
      receivingAccountHash: hash, collectionReference: null,
      signatureVerifiedAt: null, providerReconciledAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
    };
    wallet = { id: walletId, buyerId, status: 'ACTIVE', availableMinor: 0n, heldMinor: 0n };
    entries = []; inbox = [];
    config = { app: { nodeEnv: 'test', deploymentClass: 'uat' },
      gdsWallet: { sandboxEnabled: true } };
    const getInbox = async ({ where }: Row) => inbox.find((row) =>
      where.id ? row.id === where.id : row.providerEventIdentity === where.providerEventIdentity) ?? null;
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      gdsInternalTopup: {
        findUnique: jest.fn(async () => topup),
        findUniqueOrThrow: jest.fn(async () => topup),
        findFirst: jest.fn(async ({ where }: Row) =>
          where.OR.some((part: Row) => part.payosOrderCode === orderCode || part.paymentLinkId === topup.paymentLinkId)
            ? topup : null),
        update: jest.fn(async ({ data }: Row) => { Object.assign(topup, data); return topup; }),
      },
      gdsInternalPayosInbox: {
        findUnique: jest.fn(getInbox),
        findUniqueOrThrow: jest.fn(async (args: Row) => {
          const row = await getInbox(args); if (!row) throw Error('missing'); return row;
        }),
        create: jest.fn(async ({ data }: Row) => {
          const row = { id: `inbox-${inbox.length + 1}`, status: 'RECEIVED', attemptCount: 0,
            receivedAt: new Date(), nextAttemptAt: new Date(), processedAt: null,
            reviewReason: null, ...data };
          inbox.push(row); return row;
        }),
        findMany: jest.fn(async () => inbox.filter((row) => row.status === 'RECEIVED').map((row) => ({ id: row.id }))),
        update: jest.fn(async ({ where, data }: Row) => {
          const row = await getInbox({ where }); Object.assign(row!, data);
          if (data.attemptCount?.increment) row!.attemptCount += data.attemptCount.increment;
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: Row) => {
          const row = await getInbox({ where });
          if (!row || (where.status && row.status !== where.status) ||
              (where.attemptCount !== undefined && row.attemptCount !== where.attemptCount)) return { count: 0 };
          Object.assign(row, data);
          if (data.attemptCount?.increment) row.attemptCount += data.attemptCount.increment;
          return { count: 1 };
        }),
      },
      gdsInternalWallet: {
        findUnique: jest.fn(async () => wallet), findUniqueOrThrow: jest.fn(async () => wallet),
      },
      gdsInternalJournal: {
        findUnique: jest.fn(async ({ where }: Row) => entries.find((entry) =>
          where.topupId ? entry.topupId === where.topupId : entry.eventKey === where.eventKey) ?? null),
        create: jest.fn(async ({ data }: Row) => {
          entries.push(data);
          wallet.availableMinor += data.availableDeltaMinor;
          topup.status = 'CREDITED'; topup.creditedAt = new Date();
          return data;
        }),
      },
      commercePaymentAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
      commercePaymentEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      commerceSettlement: { findFirst: jest.fn().mockResolvedValue(null) },
      buyerWalletPayosTopup: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn(async (fn: (arg: Row) => Promise<unknown>) => fn(tx)),
    };
    prisma.gdsInternalPayosInbox.findUnique = jest.fn(async (args: Row) => {
      const row = await getInbox(args);
      return row && args.include?.topup ? { ...row, topup } : row;
    });
    provider = {
      reconcilePaymentRequest: jest.fn(async () => ({
        providerPaymentIdentity: event.providerPaymentIdentity,
        localOrderReference: Number(orderCode),
        amountMinor: amount, amountPaidMinor: amount, amountRemainingMinor: 0n,
        receivingAccount: account, status: 'PAID',
        createdAt: new Date(occurredAt.getTime() - 60_000),
        transactions: [{ reference: event.providerEventIdentity, amountMinor: amount,
          receivingAccount: account, occurredAt }],
      })),
    };
    const journal = new GdsInternalJournalService(prisma as never, config as never);
    service = new GdsPayosInboxService(prisma as never, config as never, provider as never, journal);
  });

  it('records only signed normalized facts and credits exactly 1 GDS for each received VND', async () => {
    expect(await service.ingestSignedIfWallet(event)).toBe('RECEIVED');
    expect(wallet.availableMinor).toBe(0n); // Webhook alone is never funds.
    expect(inbox[0].status).toBe('RECEIVED');
    expect(await service.processOne(inbox[0].id)).toBe('PROCESSED');
    expect(provider.reconcilePaymentRequest).toHaveBeenCalledWith(event.providerPaymentIdentity);
    expect(inbox[0].status).toBe('PROCESSED');
    expect(wallet.availableMinor).toBe(amount);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'TOPUP_CREDIT', topupId,
      amountMinor: amount, availableDeltaMinor: amount, clearingDeltaMinor: -amount });
    expect(topup).toMatchObject({ status: 'CREDITED', collectionReference: event.providerEventIdentity });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }));
  });

  it('ignores exact PayOS delivery replays without a second credit', async () => {
    await service.ingestSignedIfWallet(event);
    expect(await service.ingestSignedIfWallet(event)).toBe('DUPLICATE');
    expect(inbox).toHaveLength(1);
    await service.processOne(inbox[0].id);
    expect(await service.ingestSignedIfWallet(event)).toBe('DUPLICATE');
    expect(await service.processOne(inbox[0].id)).toBe('DEFERRED');
    expect(entries).toHaveLength(1);
    expect(wallet.availableMinor).toBe(amount);
  });

  it('recovers after a committed journal posting but before an inbox acknowledgement', async () => {
    await service.ingestSignedIfWallet(event);
    topup.status = 'CREDITED'; topup.collectionReference = event.providerEventIdentity;
    topup.signatureVerifiedAt = inbox[0].signatureVerifiedAt;
    topup.providerReconciledAt = new Date();
    entries.push({ kind: 'TOPUP_CREDIT', topupId, walletId, amountMinor: amount,
      collectionReference: event.providerEventIdentity });
    wallet.availableMinor = amount;
    expect(await service.processOne(inbox[0].id)).toBe('PROCESSED');
    expect(entries).toHaveLength(1);
    expect(wallet.availableMinor).toBe(amount);
  });

  it('defers provider outages, retains the verified event, then completes on recovery', async () => {
    await service.ingestSignedIfWallet(event);
    provider.reconcilePaymentRequest.mockRejectedValueOnce(new PaymentProviderError('timeout', true));
    expect(await service.processOne(inbox[0].id)).toBe('DEFERRED');
    expect(inbox[0].status).toBe('RECEIVED');
    expect(inbox[0].attemptCount).toBe(1);
    expect(wallet.availableMinor).toBe(0n);
    expect(await service.processOne(inbox[0].id)).toBe('PROCESSED');
    expect(wallet.availableMinor).toBe(amount);
  });

  it('quarantines wrong amounts, receiving accounts, cancelled and conflicting orders', async () => {
    const variants = [
      { ...event, amountMinor: amount - 1n, providerEventIdentity: 'wrong-amount', providerSettlementReference: 'wrong-amount' },
      { ...event, receivingAccount: '222222222222', providerEventIdentity: 'wrong-account', providerSettlementReference: 'wrong-account' },
      { ...event, providerPaymentIdentity: 'other-link', providerEventIdentity: 'wrong-link', providerSettlementReference: 'wrong-link' },
    ];
    for (const candidate of variants) {
      expect(await service.ingestSignedIfWallet(candidate)).toBe('REVIEW');
    }
    expect(inbox.every((entry) => entry.status === 'REVIEW')).toBe(true);
    expect(entries).toHaveLength(0);
    topup.status = 'CANCELLED';
    expect(await service.ingestSignedIfWallet({ ...event,
      providerEventIdentity: 'cancelled', providerSettlementReference: 'cancelled' })).toBe('REVIEW');
  });

  it('never credits an underpaid or multiple-transfer PayOS status', async () => {
    await service.ingestSignedIfWallet(event);
    provider.reconcilePaymentRequest.mockImplementationOnce(async () => ({
      ...await provider.reconcilePaymentRequest(), amountPaidMinor: amount - 1n,
      amountRemainingMinor: 1n, status: 'UNDERPAID',
    }));
    expect(await service.processOne(inbox[0].id)).toBe('DEFERRED');
    expect(entries).toHaveLength(0);
    const status = await provider.reconcilePaymentRequest();
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...status, transactions: [status.transactions[0], status.transactions[0]],
    });
    expect(await service.processOne(inbox[0].id)).toBe('DEFERRED');
    expect(wallet.availableMinor).toBe(0n);
  });

  it('rejects reuse of one signed reference for a conflicting topup', async () => {
    await service.ingestSignedIfWallet(event);
    await expect(service.ingestSignedIfWallet({ ...event, amountMinor: amount + 1n }))
      .rejects.toThrow('Conflicting PayOS signed event identity');
    expect(inbox).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it('quarantines Commerce identity collisions before any GDS credit', async () => {
    tx.commercePaymentAttempt.findFirst.mockResolvedValueOnce({ id: 'commerce-attempt' });
    expect(await service.ingestSignedIfWallet(event)).toBe('REVIEW');
    expect(inbox[0].reviewReason).toBe('SIGNED_IDENTITY_OR_TERMINAL_CONFLICT');
    expect(entries).toHaveLength(0);
  });

  it('fails closed with no inbox DB access in production, even if flag is set', async () => {
    config.app.nodeEnv = 'production'; config.app.deploymentClass = 'production';
    expect(await service.ingestSignedIfWallet(event)).toBeNull();
    expect(await service.processPending()).toEqual({ processed: 0, reviewed: 0, deferred: 0 });
    expect(prisma.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
    await expect(service.processOne('anything')).rejects.toThrow('GDS webhook processing disabled');
  });
});
