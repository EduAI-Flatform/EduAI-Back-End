import { GdsWalletService } from './gds-wallet.service';

const buyerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const topupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now = new Date('2026-11-03T10:00:00.000Z');
const creditedAt = new Date('2026-11-03T09:59:59.000Z');
type Row = Record<string, any>;

describe('GDS owned topup status in read-only wallet summary', () => {
  let db: Row;
  let config: Row;
  let topup: Row;
  let service: GdsWalletService;
  let summary: (owner: string, id?: string) => Promise<Row>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    config = {
      app: { nodeEnv: 'test', deploymentClass: 'uat', publicAppUrl: 'https://uat.example.org' },
      gdsWallet: { sandboxEnabled: true, qrPreviewEnabled: true, checkoutEnabled: false },
      payos: { environment: 'production' }, commerce: { idempotencySecret: 'unit-only-secret' },
    };
    topup = {
      id: topupId, buyerId, amountMinor: 10_000n, currency: 'VND', status: 'PENDING_PAYOS',
      expiresAt: new Date('2026-11-03T10:15:00.000Z'), creditedAt: null,
      collectionReference: null, signatureVerifiedAt: null, providerReconciledAt: null,
      journal: null, payosInbox: [],
      receivingAccountHash: 'private-receiver-hash', paymentLinkId: 'private-provider-link',
    };
    db = {
      gdsInternalWallet: { findUnique: jest.fn().mockResolvedValue({
        id: 'wallet-owned', status: 'ACTIVE', availableMinor: 30_000n, heldMinor: 0n,
      }) },
      gdsInternalJournal: { findMany: jest.fn().mockResolvedValue([]) },
      gdsInternalTopup: { findFirst: jest.fn(async ({ where }: Row) =>
        where.id === topup.id && where.buyerId === topup.buyerId ? topup : null) },
    };
    service = new GdsWalletService(db as never, config as never);
    summary = (owner, id) => (service.summary as unknown as
      (owner: string, id?: string) => Promise<Row>).call(service, owner, id);
  });

  afterEach(() => jest.useRealTimers());

  const markCredited = (row: Row): void => {
    Object.assign(row, {
      status: 'CREDITED', creditedAt,
      collectionReference: 'private-transfer-reference',
      signatureVerifiedAt: new Date('2026-11-03T09:59:57.000Z'),
      providerReconciledAt: new Date('2026-11-03T09:59:58.000Z'),
      journal: { kind: 'TOPUP_CREDIT', amountMinor: 10_000n, collectionReference: 'private-transfer-reference' },
    });
  };

  it('exposes completion for the requested owned intent only after matching credit evidence', async () => {
    markCredited(topup);
    const result = await summary(buyerId, topupId);

    expect(db.gdsInternalTopup.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: topupId, buyerId },
    }));
    const query = db.gdsInternalTopup.findFirst.mock.calls[0][0];
    expect(query.select).toMatchObject({
      journal: { select: { kind: true, amountMinor: true, collectionReference: true } },
      payosInbox: { select: { status: true } },
    });
    expect(JSON.stringify(query)).not.toMatch(/receivingAccount|ReceivingAccount|paymentLinkId/);
    expect(result.activeTopup).toEqual({
      topupId, amountMinor: '10000', currency: 'VND', status: 'CREDITED',
      gdsCredited: true, creditedAt: creditedAt.toISOString(),
    });
    expect(result.balance.availableMinor).toBe('30000');
    for (const privateValue of ['private-receiver-hash', 'private-provider-link', 'private-transfer-reference']) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it('does not infer this intent was credited from the wallet balance or another journal entry', async () => {
    db.gdsInternalJournal.findMany.mockResolvedValue([{
      id: 'other-topup-journal', kind: 'TOPUP_CREDIT', amountMinor: 30_000n,
      occurredAt: new Date('2026-11-03T09:00:00.000Z'),
    }]);
    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toMatchObject({ topupId, status: 'AWAITING_TRANSFER', gdsCredited: false, creditedAt: null });
    expect(result.balance.availableMinor).toBe('30000');
  });

  it('reads the completion evidence before taking the fresh balance shown with a success', async () => {
    markCredited(topup);
    let completionWasRead = false;
    db.gdsInternalTopup.findFirst.mockImplementation(async () => {
      completionWasRead = true;
      return topup;
    });
    db.gdsInternalWallet.findUnique.mockImplementation(async () => ({
      id: 'wallet-owned', status: 'ACTIVE', heldMinor: 0n,
      availableMinor: completionWasRead ? 30_000n : 20_000n,
    }));

    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toMatchObject({ status: 'CREDITED', gdsCredited: true });
    expect(result.balance.availableMinor).toBe('30000');
  });

  it.each([
    ['missing journal', { journal: null }],
    ['different journal kind', { journal: { kind: 'RESERVE', amountMinor: 10_000n, collectionReference: 'private-transfer-reference' } }],
    ['different journal amount', { journal: { kind: 'TOPUP_CREDIT', amountMinor: 20_000n, collectionReference: 'private-transfer-reference' } }],
    ['different journal reference', { journal: { kind: 'TOPUP_CREDIT', amountMinor: 10_000n, collectionReference: 'other-transfer' } }],
    ['missing collection reference', { collectionReference: null }],
    ['missing signature verification', { signatureVerifiedAt: null }],
    ['missing independent reconciliation', { providerReconciledAt: null }],
    ['invalid signature date', { signatureVerifiedAt: new Date(NaN) }],
    ['invalid reconciliation date', { providerReconciledAt: new Date(NaN) }],
    ['missing credited date', { creditedAt: null }],
    ['invalid credited date', { creditedAt: new Date(NaN) }],
  ])('reports REVIEW instead of a false success for CREDITED with %s', async (_label, patch) => {
    markCredited(topup);
    Object.assign(topup, patch);
    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toMatchObject({ topupId, status: 'REVIEW', gdsCredited: false, creditedAt: null });
    expect(result.balance.availableMinor).toBe('30000');
  });

  it.each([
    ['PAYOS_VERIFIED', [], 'RECONCILING'],
    ['PENDING_PAYOS', [{ status: 'RECEIVED' }], 'RECONCILING'],
    ['PENDING_PAYOS', [{ status: 'REVIEW' }], 'REVIEW'],
    ['REVIEW', [], 'REVIEW'],
    ['CANCELLED', [], 'CANCELLED'],
  ])('projects %s with its signed inbox state as %s', async (status, payosInbox, expected) => {
    Object.assign(topup, { status, payosInbox });
    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toMatchObject({ topupId, status: expected, gdsCredited: false, creditedAt: null });
  });

  it('reports an elapsed uncredited intent as EXPIRED without treating a balance as success', async () => {
    topup.expiresAt = new Date(now.getTime() - 1);
    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toMatchObject({ status: 'EXPIRED', gdsCredited: false, creditedAt: null });
    expect(result.balance.availableMinor).toBe('30000');
  });

  it('retains verified CREDITED status after the QR expiry', async () => {
    markCredited(topup);
    topup.expiresAt = new Date(now.getTime() - 1);
    expect((await summary(buyerId, topupId)).activeTopup).toMatchObject({
      status: 'CREDITED', gdsCredited: true, creditedAt: creditedAt.toISOString(),
    });
  });

  it('returns null status for another buyer while preserving the caller wallet balance', async () => {
    topup.buyerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    markCredited(topup);
    const result = await summary(buyerId, topupId);
    expect(db.gdsInternalTopup.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: topupId, buyerId } }));
    expect(result.activeTopup).toBeNull();
    expect(result.balance.availableMinor).toBe('30000');
  });

  it('preserves wallet data when the requested intent no longer exists', async () => {
    db.gdsInternalTopup.findFirst.mockResolvedValue(null);
    const result = await summary(buyerId, topupId);
    expect(result.activeTopup).toBeNull();
    expect(result).toMatchObject({ available: true, state: 'READY_SANDBOX', balance: { availableMinor: '30000' } });
  });

  it('does not query an arbitrary active intent when no topup ID was requested', async () => {
    const result = await summary(buyerId);
    expect(result.activeTopup).toBeNull();
    expect(db.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['feature disabled', false, 'test', 'uat'],
    ['production runtime', true, 'production', 'uat'],
    ['production deployment', true, 'test', 'production'],
  ])('never queries topup or wallet data for %s', async (_label, enabled, nodeEnv, deploymentClass) => {
    config.gdsWallet.sandboxEnabled = enabled;
    config.app.nodeEnv = nodeEnv;
    config.app.deploymentClass = deploymentClass;
    expect(await summary(buyerId, topupId)).toMatchObject({ available: false, activeTopup: null });
    expect(db.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
    expect(db.gdsInternalJournal.findMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed optional topup ID before database access', async () => {
    await expect(summary(buyerId, 'not-a-uuid')).rejects.toThrow();
    expect(db.gdsInternalTopup.findFirst).not.toHaveBeenCalled();
    expect(db.gdsInternalWallet.findUnique).not.toHaveBeenCalled();
  });
});
