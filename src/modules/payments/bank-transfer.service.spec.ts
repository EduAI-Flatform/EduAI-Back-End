import { BankTransferService } from './bank-transfer.service';
import { requireBankTransferProof } from './bank-transfer-proof';
import { BankApprovalDto } from './dto/bank-transfer.dto';

describe('manual bank statement authorization and settlement', () => {
  const reviewer = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const oldFlag = process.env.BANK_TRANSFER_SANDBOX_ENABLED;
  const oldOperators = process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS;
  beforeEach(() => {
    process.env.BANK_TRANSFER_SANDBOX_ENABLED = 'true';
    process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS = `${reviewer},${other}`;
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.BANK_TRANSFER_SANDBOX_ENABLED;
    else process.env.BANK_TRANSFER_SANDBOX_ENABLED = oldFlag;
    if (oldOperators === undefined) delete process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS;
    else process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS = oldOperators;
  });
  function harness() {
    const now = Date.now();
    const request: any = { id: 'request', orderId: 'order', paymentAttemptId: 'attempt', status: 'UNDER_REVIEW',
      bankBin: '970422', accountNumber: '0000000000', amountMinor: 100000n, transferContent: 'EDUAI123456',
      createdAt: new Date(now - 60_000), expiresAt: new Date(now + 60_000) };
    const evidence: any = { id: 'evidence', requestId: request.id, ...request, amountMinor: 100000n,
      occurredAt: new Date(now - 30_000), exceptionReason: null, transactionId: 'BANK-TXN-1', statementSha256: 'a'.repeat(64) };
    evidence.id = 'evidence';
    const order: any = { id: 'order', buyerId: 'learner', status: 'pending_payment', payableAmountMinor: 100000n, confirmedSettlementId: null };
    const approvals: any[] = [];
    const tx: any = { $queryRaw: jest.fn(), user: { findFirst: jest.fn().mockResolvedValue({ id: reviewer }) },
      commerceBankTransferRequest: { findUniqueOrThrow: jest.fn(async () => request), update: jest.fn(async ({ data }) => Object.assign(request, data)) },
      commerceBankStatementEvidence: { findUniqueOrThrow: jest.fn(async () => evidence) },
      commerceBankApproval: { findUnique: jest.fn(async ({ where }) => approvals.find((a) => a.actorId === where.evidenceId_actorId.actorId) ?? null),
        create: jest.fn(async ({ data }) => { approvals.push(data); return data; }),
        findMany: jest.fn(async () => approvals) },
      commerceIdempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'key' }), update: jest.fn() },
      commerceOrder: { findUniqueOrThrow: jest.fn(async () => order), update: jest.fn(async ({ data }) => Object.assign(order, data)) },
      commercePromotionReservation: { findMany: jest.fn().mockResolvedValue([]) },
      commercePaymentEvent: { create: jest.fn().mockResolvedValue({ id: 'event' }) },
      commerceSettlement: { create: jest.fn().mockResolvedValue({ id: 'settlement' }), findFirst: jest.fn().mockResolvedValue({ id: 'settlement' }) },
      commercePaymentAttempt: { update: jest.fn() }, commerceLifecycleEvent: { create: jest.fn() } };
    const prisma: any = { $transaction: jest.fn(async (fn) => fn(tx)) };
    const fulfillment: any = { fulfillConfirmedPayment: jest.fn().mockResolvedValue(undefined) };
    const audit: any = { record: jest.fn() };
    const service = new BankTransferService(prisma, { app: { nodeEnv: 'test' } } as any, audit, fulfillment);
    const input: BankApprovalDto = { source: 'BANK_STATEMENT_CHECKED', statementSha256: evidence.statementSha256,
      transactionId: evidence.transactionId, amountMinor: '100000', accountNumber: evidence.accountNumber, transferContent: evidence.transferContent };
    return { service, tx, request, evidence, approvals, order, fulfillment, input, prisma, audit };
  }
  it('production is denied before any DB query despite opt-in', async () => {
    const h = harness();
    const service = new BankTransferService(h.prisma, { app: { nodeEnv: 'production' } } as any, h.audit, h.fulfillment);
    await expect(service.approve(reviewer, 'evidence', 'unique-key-1', h.input)).rejects.toThrow('Bank transfer is unavailable');
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('pages older review requests with deterministic ordering after operator authorization', async () => {
    const h = harness();
    h.prisma.commerceBankTransferRequest = { count: jest.fn().mockResolvedValue(41),
      findMany: jest.fn().mockResolvedValue([{ id: 'older-request', orderId: 'older-order' }]) };
    await expect(h.service.list(reviewer, { page: 2, pageSize: 20 })).resolves.toEqual({
      items: [{ id: 'older-request', orderId: 'older-order' }], page: 2, pageSize: 20, total: 41, totalPages: 3,
    });
    expect(h.prisma.commerceBankTransferRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 20, take: 20,
    }));
  });
  it('cannot inspect the queue without current operator authority', async () => {
    const h = harness(); h.tx.user.findFirst.mockResolvedValue(null);
    h.prisma.commerceBankTransferRequest = { count: jest.fn(), findMany: jest.fn() };
    await expect(h.service.list(reviewer, { page: 2, pageSize: 20 })).rejects.toThrow('operator authorization');
    expect(h.prisma.commerceBankTransferRequest.count).not.toHaveBeenCalled();
    expect(h.prisma.commerceBankTransferRequest.findMany).not.toHaveBeenCalled();
  });
  it('disabled deployment reads no additive bank tables before migration', async () => {
    const h = harness(); delete process.env.BANK_TRANSFER_SANDBOX_ENABLED;
    expect(await h.service.ownsBankOrder('learner', 'order')).toBe(false);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(await h.service.expireDue()).toEqual({ expired: 0, fulfilled: 0, failed: 0 });
  });
  it('production proof rejects before any database read', async () => {
    const before = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { await expect(requireBankTransferProof({} as any, 'order', 's')).rejects.toThrow('BANK_TRANSFER_DISABLED'); }
    finally { process.env.NODE_ENV = before; }
  });
  it('expiry retains system attribution and releases reservations', async () => {
    const h = harness();
    h.tx.commerceOrder.findFirst = jest.fn(async () => h.order);
    await (h.service as any).close('learner', 'order', 'EXPIRED');
    expect(h.request.status).toBe('EXPIRED');
    expect(h.order.status).toBe('expired');
    expect(h.tx.commerceLifecycleEvent.create.mock.calls.every(([arg]: any[]) => arg.data.actorKind === 'system' && arg.data.actorId === null)).toBe(true);
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorKind: 'SYSTEM', action: 'PAYMENT_REQUEST_EXPIRED' }), h.tx);
  });
  it('denies an admin outside the operator allowlist', async () => {
    const h = harness();
    await expect(h.service.approve('unauthorized', 'evidence', 'unique-key-1', h.input)).rejects.toThrow('operator authorization');
    expect(h.tx.commercePaymentEvent.create).not.toHaveBeenCalled();
  });
  it('denies a suspended or revoked admin even if allowlisted', async () => {
    const h = harness(); h.tx.user.findFirst.mockResolvedValue(null);
    await expect(h.service.approve(reviewer, 'evidence', 'unique-key-1', h.input)).rejects.toThrow('operator authorization');
  });
  it('requires independent re-entry of exact statement facts', async () => {
    const h = harness();
    await expect(h.service.approve(reviewer, 'evidence', 'unique-key-1', { ...h.input, amountMinor: '99999' })).rejects.toThrow('BANK_INDEPENDENT_REVIEW_MISMATCH');
    expect(h.approvals).toHaveLength(0);
  });
  it('one admin cannot settle by approving twice; two different admins settle once', async () => {
    const h = harness();
    expect((await h.service.approve(reviewer, 'evidence', 'unique-key-1', h.input)).status).toBe('UNDER_REVIEW');
    expect((await h.service.approve(reviewer, 'evidence', 'unique-key-2', h.input)).status).toBe('UNDER_REVIEW');
    expect(h.order.status).toBe('pending_payment');
    expect(h.tx.commerceSettlement.create).not.toHaveBeenCalled();
    expect((await h.service.approve(other, 'evidence', 'unique-key-3', h.input)).status).toBe('PAID');
    expect(h.order.confirmedSettlementId).toBe('settlement');
    expect(h.request.status).toBe('PAID');
    await h.service.approve(other, 'evidence', 'unique-key-3', h.input);
    expect(h.tx.commerceSettlement.create).toHaveBeenCalledTimes(1);
    expect(h.fulfillment.fulfillConfirmedPayment).toHaveBeenCalledWith('order', 'settlement', 'user', other);
  });
  it.each(['EXPIRED', 'CANCELLED', 'NEEDS_SUPPORT'])('cannot settle request state %s', async (status) => {
    const h = harness(); h.request.status = status;
    await expect(h.service.approve(reviewer, 'evidence', 'unique-key-1', h.input)).rejects.toThrow('BANK_EVIDENCE_REQUIRES_SUPPORT');
    expect(h.tx.commercePaymentEvent.create).not.toHaveBeenCalled();
  });
  it('cannot settle mismatched, late or suspicious evidence', async () => {
    const h = harness(); h.evidence.exceptionReason = 'SUSPECTED_TRANSFER';
    await expect(h.service.approve(reviewer, 'evidence', 'unique-key-1', h.input)).rejects.toThrow('BANK_EVIDENCE_REQUIRES_SUPPORT');
  });
  it('keeps financial result when post-commit fulfillment fails and retry reuses settlement', async () => {
    const h = harness();
    await h.service.approve(reviewer, 'evidence', 'unique-key-1', h.input);
    h.fulfillment.fulfillConfirmedPayment.mockRejectedValueOnce(new Error('synthetic downstream failure'));
    await expect(h.service.approve(other, 'evidence', 'unique-key-2', h.input)).rejects.toThrow('synthetic downstream failure');
    expect(h.order.status).toBe('confirmed');
    await h.service.approve(other, 'evidence', 'unique-key-2', h.input);
    expect(h.tx.commerceSettlement.create).toHaveBeenCalledTimes(1);
  });
  it('refuses course fulfillment when a paid order lacks trustworthy bank evidence', async () => {
    const tx: any = { commerceOrder: { findUnique: jest.fn().mockResolvedValue({ status: 'confirmed', confirmedSettlementId: 's' }) },
      commerceSettlement: { findUnique: jest.fn().mockResolvedValue({ provider: 'bank_transfer', providerSettlementReference: 'e' }) },
      commerceBankTransferRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      commerceBankStatementEvidence: { findUnique: jest.fn().mockResolvedValue(null) } };
    await expect(requireBankTransferProof(tx, 'order', 's')).rejects.toThrow('BANK_STATEMENT_PROOF_REQUIRED');
  });
});
