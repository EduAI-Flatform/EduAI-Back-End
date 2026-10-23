import { receiptSandboxEnabled } from './bank-transfer-receipt-policy';
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AuditActorKind, CommerceActorKind, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';
import { BANK_SANDBOX_RECEIVER, bankQrPreviewReceiver, bankTransferEnabled, classifyBankEvidence, createVietQrPayload } from './bank-transfer-policy';
import { BankApprovalDto, BankStatementDto } from './dto/bank-transfer.dto';
import { ListPendingPaymentQueryDto, PaymentRequestResponseDto } from './dto/payment-request-response.dto';

@Injectable()
export class BankTransferService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService,
    private readonly audit: AuditService, private readonly fulfillment: CommerceFulfillmentService) {}

  enabled() { return bankTransferEnabled(this.config.app.nodeEnv, process.env.BANK_TRANSFER_SANDBOX_ENABLED); }
  async previewBankQr() {
    const receiver = bankQrPreviewReceiver(process.env);
    if (!receiver) throw new ServiceUnavailableException('BANK_QR_PREVIEW_DISABLED');
    const transferContent = 'EDUAIPREVIEW';
    const amountMinor = 1000n;
    const payload = createVietQrPayload(receiver.bankBin, receiver.accountNumber, amountMinor, transferContent);
    return {
      previewOnly: true, acceptsPayments: false, bankTransferProductionEnabled: false,
      ...receiver, amountMinor: amountMinor.toString(), currency: 'VND', transferContent,
      qrCodeDataUrl: await QRCode.toDataURL(payload, { margin: 4, width: 480 }),
      warning: 'CHỈ KIỂM TRA TÊN NGƯỜI NHẬN — KHÔNG CHUYỂN TIỀN. QR không xác nhận chủ tài khoản hay quyền thu tiền.',
    };
  }
  private assertEnabled() {
    if (!this.enabled()) throw new ServiceUnavailableException({ error: 'BANK_TRANSFER_DISABLED', message: 'Bank transfer is unavailable.' });
  }
  private async operator(tx: Prisma.TransactionClient, actorId: string) {
    this.assertEnabled();
    const allowed = (process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS ?? '').split(',');
    const user = await tx.user.findFirst({ where: { id: actorId, status: 'active', deletedAt: null,
      roles: { some: { role: { name: 'platform_admin' } } } }, select: { id: true } });
    if (!allowed.includes(actorId) || !user) throw new ForbiddenException('Bank reconciliation operator authorization required.');
  }
  async ownsBankOrder(learnerId: string, orderId: string) {
    if (!this.enabled()) return false;
    const order = await this.prisma.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId }, select: { id: true } });
    return order ? Boolean(await this.prisma.commerceBankTransferRequest.findUnique({ where: { orderId } })) : false;
  }
  async create(learnerId: string, orderId: string, key: string | undefined): Promise<PaymentRequestResponseDto> {
    this.assertEnabled();
    await this.serializable(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId } });
      if (!order) throw new NotFoundException('Payment request was not found.');
      await this.idempotency(tx, learnerId, 'bank.create', key, orderId);
      const existing = await tx.commerceBankTransferRequest.findUnique({ where: { orderId } });
      if (existing) return;
      if (order.status !== 'pending_payment' || order.currency !== 'VND' || order.payableAmountMinor <= 0n ||
          order.payableAmountMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictException('ORDER_NOT_PAYABLE');
      const open = await tx.commercePaymentAttempt.findFirst({ where: { orderId, status: { in: ['created', 'pending'] } } });
      if (open) throw new ConflictException('PAYMENT_METHOD_ALREADY_SELECTED');
      const now = new Date();
      const reservations = await tx.commercePromotionReservation.findMany({ where: { orderId, status: 'reserved' } });
      const expiresAt = new Date(Math.min(now.getTime() + 900_000, ...reservations.map((r) => r.expiresAt.getTime())));
      if (expiresAt <= now) throw new ConflictException('ORDER_EXPIRED');
      const id = randomUUID(); const attemptId = randomUUID();
      await tx.commercePaymentAttempt.create({ data: { id: attemptId, orderId, provider: 'bank_transfer',
        localRequestIdentity: id, providerPaymentIdentity: id, amountMinor: order.payableAmountMinor,
        currency: 'VND', providerExpiresAt: expiresAt, createdAt: now } });
      const operationId = randomUUID();
      await tx.commercePaymentAttempt.update({ where: { id: attemptId }, data: { status: 'pending', statusOperationId: operationId } });
      await this.lifecycle(tx, 'payment', attemptId, 'created', 'pending', learnerId, operationId, 'BANK_SANDBOX_REQUEST_CREATED');
      await tx.commerceBankTransferRequest.create({ data: { id, orderId, paymentAttemptId: attemptId,
        ...BANK_SANDBOX_RECEIVER, amountMinor: order.payableAmountMinor, transferContent: `EDUAI${id.replace(/-/g, '').slice(0, 20).toUpperCase()}`,
        createdAt: now, expiresAt } });
      await this.audit.record({ actorId: learnerId, action: AuditAction.PaymentRequestCreated,
        target: { type: 'commerce_order', id: orderId }, metadata: { operationId, paymentAttemptId: attemptId, provider: 'bank_transfer', sandbox: true } }, tx);
    });
    return this.status(learnerId, orderId);
  }
  async status(learnerId: string, orderId: string): Promise<PaymentRequestResponseDto> {
    this.assertEnabled();
    const order = await this.prisma.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId } });
    if (!order) throw new NotFoundException('Payment request was not found.');
    let request = await this.prisma.commerceBankTransferRequest.findUnique({ where: { orderId } });
    if (!request) throw new NotFoundException('Bank payment request was not found.');
    if (['PENDING', 'UNDER_REVIEW', 'NEEDS_SUPPORT'].includes(request.status) && request.expiresAt <= new Date()) {
      await this.close(learnerId, orderId, 'EXPIRED');
      request = await this.prisma.commerceBankTransferRequest.findUniqueOrThrow({ where: { orderId } });
    }
    const bankTransfer = { bankName: request.bankName, bankBin: request.bankBin, accountNumber: request.accountNumber,
      beneficiaryName: request.beneficiaryName, transferContent: request.transferContent };
    const pending = ['PENDING', 'UNDER_REVIEW', 'NEEDS_SUPPORT'].includes(request.status);
    return { orderId, orderNumber: order.orderNumber, orderStatus: request.status === 'EXPIRED' ? 'EXPIRED' : order.status.toUpperCase(), paymentRequired: true,
      payment: { id: request.paymentAttemptId, provider: 'bank_transfer', status: request.status,
        amount: { amountMinor: request.amountMinor.toString(), currency: 'VND' }, expiresAt: request.expiresAt, bankTransfer,
        ...(pending && receiptSandboxEnabled(this.config.app.nodeEnv, process.env, learnerId) ? { receiptUploadEnabled: true } : {}),
        ...(pending ? { qrCodeDataUrl: await QRCode.toDataURL(createVietQrPayload(request.bankBin, request.accountNumber, request.amountMinor, request.transferContent), { margin: 4, width: 480 }) } : {}) } };
  }
  async support(learnerId: string, orderId: string, key: string | undefined, reason: string) {
    this.assertEnabled();
    await this.serializable(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId } });
      if (!order) throw new NotFoundException();
      await this.idempotency(tx, learnerId, 'bank.support', key, `${orderId}:${reason}`);
      const request = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { orderId } });
      const operationKeyHash = createHash('sha256').update(key as string).digest('hex');
      const previous = await tx.commerceBankSupportRequest.findUnique({ where: { actorId_operationKeyHash: { actorId: learnerId, operationKeyHash } } });
      if (previous) return;
      await tx.commerceBankSupportRequest.create({ data: { id: randomUUID(), requestId: request.id, actorId: learnerId, reason, operationKeyHash } });
      if (['PENDING', 'UNDER_REVIEW'].includes(request.status)) await tx.commerceBankTransferRequest.update({ where: { orderId }, data: { status: 'NEEDS_SUPPORT' } });
      await this.audit.record({ actorId: learnerId, action: AuditAction.PaymentWebhookReconciliationRequired,
        target: { type: 'commerce_bank_transfer_request', id: request.id }, metadata: { reasonCode: 'LEARNER_REQUESTED_TRACE', reasonDigest: createHash('sha256').update(reason).digest('hex') } }, tx);
    });
    return this.status(learnerId, orderId);
  }
  async cancel(learnerId: string, orderId: string, key: string | undefined) {
    this.assertEnabled();
    await this.close(learnerId, orderId, 'CANCELLED', key);
    const result = await this.status(learnerId, orderId);
    return { orderId, orderStatus: result.orderStatus, paymentStatus: result.payment?.status ?? null };
  }
  private async close(learnerId: string, orderId: string, status: 'CANCELLED' | 'EXPIRED', key?: string) {
    await this.serializable(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId } });
      if (!order) throw new NotFoundException();
      if (status === 'CANCELLED') await this.idempotency(tx, learnerId, 'bank.cancel', key, orderId);
      const request = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { orderId } });
      if (['PAID', 'CANCELLED', 'EXPIRED'].includes(request.status)) return;
      if (order.status !== 'pending_payment') throw new ConflictException('ORDER_STATE_CHANGED');
      const next = status === 'EXPIRED' ? 'expired' : 'cancelled'; const now = new Date();
      const lifecycleActorId = status === 'EXPIRED' ? null : learnerId;
      const operationId = randomUUID();
      await tx.commercePaymentAttempt.update({ where: { id: request.paymentAttemptId }, data: {
        status: next, statusOperationId: operationId, closedAt: now, providerStatusCheckedAt: now } });
      await this.lifecycle(tx, 'payment', request.paymentAttemptId, 'pending', next, lifecycleActorId, operationId, 'BANK_WINDOW_CLOSED_TRANSFER_STILL_POSSIBLE');
      await tx.commerceBankTransferRequest.update({ where: { orderId }, data: { status } });
      const orderOperation = randomUUID();
      await tx.commerceOrder.update({ where: { id: orderId }, data: { status: next, statusOperationId: orderOperation,
        ...(next === 'expired' ? { expiredAt: now } : { cancelledAt: now }) } });
      await this.lifecycle(tx, 'order', orderId, 'pending_payment', next, lifecycleActorId, orderOperation, 'BANK_WINDOW_CLOSED');
      for (const reservation of await tx.commercePromotionReservation.findMany({ where: { orderId, status: 'reserved' } })) {
        const op = randomUUID(); const reservationStatus = status === 'EXPIRED' ? 'expired' : 'released';
        await tx.commercePromotionReservation.update({ where: { id: reservation.id }, data: { status: reservationStatus, statusOperationId: op,
          ...(status === 'EXPIRED' ? { expiredAt: now } : { releasedAt: now }) } });
        await this.lifecycle(tx, 'reservation', reservation.id, 'reserved', reservationStatus, lifecycleActorId, op, 'BANK_WINDOW_CLOSED');
      }
      await this.audit.record({ ...(lifecycleActorId ? { actorId: lifecycleActorId } : { actorKind: AuditActorKind.SYSTEM }), action: status === 'EXPIRED' ? AuditAction.PaymentRequestExpired : AuditAction.PaymentRequestCancelled,
        target: { type: 'commerce_order', id: orderId }, metadata: { operationId: orderOperation, provider: 'bank_transfer' } }, tx);
    });
  }
  async recordStatement(actorId: string, requestId: string, key: string | undefined, input: BankStatementDto) {
    this.assertEnabled();
    if (input.source !== 'BANK_STATEMENT_CHECKED') throw new ConflictException('BANK_STATEMENT_SOURCE_REQUIRED');
    return this.serializable(async (tx) => {
      await this.operator(tx, actorId);
      const request = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { id: requestId } });
      await this.lockOrder(tx, request.orderId);
      await this.idempotency(tx, actorId, 'bank.statement', key, JSON.stringify({ requestId, ...input }));
      const previous = await tx.commerceBankStatementEvidence.findUnique({ where: { bankBin_accountNumber_transactionId: {
        bankBin: input.bankBin, accountNumber: input.accountNumber, transactionId: input.transactionId } } });
      if (previous) {
        if (previous.requestId !== requestId || previous.statementSha256 !== input.statementSha256 || previous.amountMinor !== BigInt(input.amountMinor) ||
          previous.transferContent !== input.transferContent || previous.occurredAt.getTime() !== new Date(input.occurredAt).getTime()) throw new ConflictException('BANK_TRANSACTION_ALREADY_RECORDED');
        return { id: previous.id, exceptionReason: previous.exceptionReason };
      }
      const facts = { ...input, amountMinor: BigInt(input.amountMinor), occurredAt: new Date(input.occurredAt) };
      const exceptionReason = (input.suspicious === true ? 'SUSPECTED_TRANSFER' : null) ?? classifyBankEvidence(request, facts) ??
        (['CANCELLED', 'EXPIRED', 'PAID'].includes(request.status) ? 'CLOSED_REQUEST' : null);
      const evidence = await tx.commerceBankStatementEvidence.create({ data: { id: randomUUID(), requestId,
        bankBin: input.bankBin, accountNumber: input.accountNumber, transactionId: input.transactionId,
        amountMinor: facts.amountMinor, transferContent: input.transferContent, occurredAt: facts.occurredAt,
        statementReference: input.statementReference, statementSha256: input.statementSha256, recordedById: actorId, exceptionReason } });
      if (!['CANCELLED', 'EXPIRED', 'PAID'].includes(request.status)) await tx.commerceBankTransferRequest.update({ where: { id: requestId }, data: { status: exceptionReason ? 'NEEDS_SUPPORT' : 'UNDER_REVIEW' } });
      await this.audit.record({ actorId, action: AuditAction.PaymentReconciliationChecked,
        target: { type: 'commerce_bank_statement_evidence', id: evidence.id }, metadata: { requestId, exceptionReason, statementSha256: input.statementSha256 } }, tx);
      return { id: evidence.id, exceptionReason };
    });
  }
  async approve(actorId: string, evidenceId: string, key: string | undefined, input: BankApprovalDto) {
    this.assertEnabled();
    const result = await this.serializable(async (tx) => {
      await this.operator(tx, actorId);
      const evidence = await tx.commerceBankStatementEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
      if (input.source !== 'BANK_STATEMENT_CHECKED' || input.statementSha256 !== evidence.statementSha256 ||
          input.transactionId !== evidence.transactionId || BigInt(input.amountMinor) !== evidence.amountMinor ||
          input.transferContent !== evidence.transferContent || input.accountNumber !== evidence.accountNumber) {
        throw new ConflictException('BANK_INDEPENDENT_REVIEW_MISMATCH');
      }
      const initial = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { id: evidence.requestId } });
      await this.lockOrder(tx, initial.orderId);
      await this.idempotency(tx, actorId, 'bank.approve', key, JSON.stringify({ evidenceId, ...input }));
      const request = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { id: evidence.requestId } });
      if (request.status === 'PAID') {
        const settlement = await tx.commerceSettlement.findFirst({ where: { provider: 'bank_transfer', providerSettlementReference: evidence.id } });
        if (!settlement) throw new ConflictException('BANK_TRANSACTION_NOT_CANONICAL');
        return { orderId: request.orderId, settlementId: settlement.id, status: 'PAID' };
      }
      if (evidence.exceptionReason || classifyBankEvidence(request, evidence) || request.expiresAt <= new Date() ||
          request.status !== 'UNDER_REVIEW') throw new ConflictException('BANK_EVIDENCE_REQUIRES_SUPPORT');
      const previousApproval = await tx.commerceBankApproval.findUnique({ where: { evidenceId_actorId: { evidenceId, actorId } } });
      if (!previousApproval) await tx.commerceBankApproval.create({ data: { evidenceId, actorId } });
      const approvals = await tx.commerceBankApproval.findMany({ where: { evidenceId } });
      // Recheck current active admin authority for BOTH approvers before committing money.
      for (const approval of approvals) await this.operator(tx, approval.actorId);
      await this.audit.record({ actorId, action: AuditAction.PaymentReconciliationChecked,
        target: { type: 'commerce_bank_statement_evidence', id: evidenceId }, metadata: { distinctApprovalCount: approvals.length } }, tx);
      if (approvals.length < 2) return { orderId: request.orderId, settlementId: null, status: 'UNDER_REVIEW' };
      const order = await tx.commerceOrder.findUniqueOrThrow({ where: { id: request.orderId } });
      if (order.status !== 'pending_payment' || order.payableAmountMinor !== request.amountMinor || order.confirmedSettlementId) throw new ConflictException('ORDER_NOT_PAYABLE');
      const reservations = await tx.commercePromotionReservation.findMany({ where: { orderId: order.id, status: 'reserved' } });
      if (reservations.some((r) => r.expiresAt <= new Date())) throw new ConflictException('ORDER_BENEFITS_EXPIRED');
      const event = await tx.commercePaymentEvent.create({ data: { paymentAttemptId: request.paymentAttemptId,
        provider: 'bank_transfer', providerEventIdentity: evidence.id, providerPaymentIdentity: request.id,
        providerSettlementReference: evidence.id, amountMinor: request.amountMinor, currency: 'VND', nextStatus: 'paid', providerOccurredAt: evidence.occurredAt } });
      const settlement = await tx.commerceSettlement.create({ data: { orderId: order.id, paymentAttemptId: request.paymentAttemptId,
        paymentEventId: event.id, kind: 'provider_collection', disposition: 'matched', provider: 'bank_transfer',
        providerSettlementReference: evidence.id, amountMinor: request.amountMinor, currency: 'VND', settledAt: evidence.occurredAt } });
      const paymentOp = randomUUID();
      await tx.commercePaymentAttempt.update({ where: { id: request.paymentAttemptId }, data: { status: 'paid', statusOperationId: paymentOp, paidAt: evidence.occurredAt } });
      await this.lifecycle(tx, 'payment', request.paymentAttemptId, 'pending', 'paid', actorId, paymentOp, 'BANK_DUAL_STATEMENT_CONFIRMED');
      await tx.commerceBankTransferRequest.update({ where: { id: request.id }, data: { status: 'PAID' } });
      const orderOp = randomUUID();
      await tx.commerceOrder.update({ where: { id: order.id }, data: { status: 'confirmed', statusOperationId: orderOp,
        confirmedAt: new Date(), confirmedSettlementId: settlement.id } });
      await this.lifecycle(tx, 'order', order.id, 'pending_payment', 'confirmed', actorId, orderOp, 'BANK_DUAL_STATEMENT_CONFIRMED');
      for (const reservation of reservations) {
        const op = randomUUID();
        await tx.commercePromotionReservation.update({ where: { id: reservation.id }, data: { status: 'consumed', statusOperationId: op, consumedAt: new Date() } });
        await this.lifecycle(tx, 'reservation', reservation.id, 'reserved', 'consumed', actorId, op, 'BANK_DUAL_STATEMENT_CONFIRMED');
      }
      await this.audit.record({ actorId, action: AuditAction.PaymentReconciliationResolved,
        target: { type: 'commerce_order', id: order.id }, metadata: { settlementId: settlement.id, evidenceId, sandbox: true } }, tx);
      return { orderId: order.id, settlementId: settlement.id, status: 'PAID' };
    });
    // Financial evidence stays committed if entitlement delivery fails; repeat approval safely retries fulfillment.
    if (result.settlementId) await this.fulfillment.fulfillConfirmedPayment(result.orderId, result.settlementId, CommerceActorKind.user, actorId);
    return result;
  }
  async list(actorId: string, query: ListPendingPaymentQueryDto = { page: 1, pageSize: 20 }) {
    await this.serializable((tx) => this.operator(tx, actorId));
    const [total, items] = await Promise.all([
      this.prisma.commerceBankTransferRequest.count(),
      this.prisma.commerceBankTransferRequest.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        select: { id: true, orderId: true, status: true, transferContent: true, createdAt: true, expiresAt: true },
      }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }
  async expireDue() {
    if (!this.enabled()) return { expired: 0, fulfilled: 0, failed: 0 };
    const counts = { expired: 0, fulfilled: 0, failed: 0 };
    const due = await this.prisma.commerceBankTransferRequest.findMany({ where: {
      status: { in: ['PENDING', 'UNDER_REVIEW', 'NEEDS_SUPPORT'] }, expiresAt: { lte: new Date() } }, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: 20 });
    for (const request of due) {
      try {
        const order = await this.prisma.commerceOrder.findUniqueOrThrow({ where: { id: request.orderId } });
        await this.close(order.buyerId, order.id, 'EXPIRED');
        counts.expired += 1;
      } catch { counts.failed += 1; }
    }
    const failed = await this.prisma.commerceOrder.findMany({ where: { status: 'confirmed', fulfillmentStatus: { in: ['not_started', 'failed'] },
      confirmedSettlement: { provider: 'bank_transfer' } }, select: { id: true, confirmedSettlementId: true }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 20 });
    for (const order of failed) if (order.confirmedSettlementId) {
      try {
        await this.fulfillment.fulfillConfirmedPayment(order.id, order.confirmedSettlementId, CommerceActorKind.system, null);
        counts.fulfilled += 1;
      } catch { counts.failed += 1; }
    }
    return counts;
  }
  async detail(actorId: string, requestId: string) {
    await this.serializable((tx) => this.operator(tx, actorId));
    const request = await this.prisma.commerceBankTransferRequest.findUniqueOrThrow({ where: { id: requestId } });
    const statements = await this.prisma.commerceBankStatementEvidence.findMany({ where: { requestId }, orderBy: { recordedAt: 'desc' }, take: 100 });
    const approvals = await this.prisma.commerceBankApproval.findMany({ where: { evidenceId: { in: statements.map((s) => s.id) } }, take: 200 });
    const support = await this.prisma.commerceBankSupportRequest.findMany({ where: { requestId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { request: { ...request, amountMinor: request.amountMinor.toString() },
      statements: statements.map((s) => ({ ...s, amountMinor: s.amountMinor.toString() })), approvals, support };
  }
  private async idempotency(tx: Prisma.TransactionClient, actorId: string, operation: string, key: string | undefined, request: string) {
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ConflictException('INVALID_IDEMPOTENCY_KEY');
    const keyHash = createHash('sha256').update(key).digest('hex');
    const requestHash = createHash('sha256').update(request).digest('hex');
    const existing = await tx.commerceIdempotencyRecord.findUnique({ where: { actorId_operation_keyHashVersion_keyHash: { actorId, operation, keyHashVersion: 1, keyHash } } });
    if (existing) { if (existing.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED'); return; }
    const now = new Date();
    const row = await tx.commerceIdempotencyRecord.create({ data: { actorId, operation, keyHash, keyHashVersion: 1,
      requestHash, requestCanonicalizationVersion: 1, status: 'in_progress', lockedUntil: now } });
    await tx.commerceIdempotencyRecord.update({ where: { id: row.id }, data: { status: 'completed', completedAt: now, resourceType: 'bank_operation', resourceId: row.id, lockedUntil: now } });
  }
  private lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    return tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id=${orderId}::uuid FOR UPDATE`);
  }
  private lifecycle(tx: Prisma.TransactionClient, entityType: 'payment' | 'order' | 'reservation', entityId: string,
    previousStatus: string, nextStatus: string, actorId: string | null, operationId: string, reasonCode: string) {
    return tx.commerceLifecycleEvent.create({ data: { entityType, entityId, previousStatus, nextStatus, actorKind: actorId ? 'user' : 'system', actorId, operationId, reasonCode } });
  }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2034', 'P2002'].includes(error.code) || attempt === 2) throw error; }
    }
    throw new ConflictException('BANK_CONCURRENT_OPERATION');
  }
}
