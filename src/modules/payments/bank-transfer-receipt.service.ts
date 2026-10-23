import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CommerceBankReceiptClaim, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { BankReceiptStorageService } from './bank-transfer-receipt-storage.service';
import { BankReceiptOcrService } from './bank-transfer-receipt-ocr.service';
import { decodeReceiptImage } from './bank-transfer-receipt-image';
import { assessReceiptClaim, receiptSandboxEnabled } from './bank-transfer-receipt-policy';
import { bankTransferEnabled } from './bank-transfer-policy';

type Upload = { buffer: Buffer; size: number; mimetype: string } | undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class BankReceiptService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService,
    private readonly audit: AuditService, private readonly storage: BankReceiptStorageService,
    private readonly ocr: BankReceiptOcrService) {}

  async upload(buyerId: string, orderId: string, key: string | undefined, file: Upload) {
    this.assertBuyerEnabled(buyerId);
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ConflictException('INVALID_IDEMPOTENCY_KEY');
    // Authorization precedes the decoder and all filesystem/provider work.
    await this.serializable(tx => this.ownedOrder(tx, buyerId, orderId));
    const image = await decodeReceiptImage(file);
    const operationKeyHash = digest(key);
    let created: { claim: CommerceBankReceiptClaim; fresh: boolean };
    try {
      created = await this.serializable(async tx => {
        const { request, order } = await this.ownedOrder(tx, buyerId, orderId);
        const previous = await tx.commerceBankReceiptClaim.findUnique({ where: { buyerId_operationKeyHash: { buyerId, operationKeyHash } } });
        if (previous) {
          if (previous.orderId !== orderId || previous.originalSha256 !== image.originalSha256 || previous.imageSha256 !== image.imageSha256) {
            throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
          }
          return { claim: previous, fresh: false };
        }
        if (order.status !== 'pending_payment' || !['PENDING', 'UNDER_REVIEW', 'NEEDS_SUPPORT'].includes(request.status) || request.expiresAt <= new Date()) throw new ConflictException('ORDER_NOT_PAYABLE');
        if (await tx.commerceBankReceiptClaim.count({ where: { orderId } }) >= 3) throw new ConflictException('RECEIPT_UPLOAD_LIMIT');
        if (await tx.commerceBankReceiptClaim.findFirst({ where: { OR: [{ originalSha256: image.originalSha256 }, { imageSha256: image.imageSha256 }] } })) throw new ConflictException('RECEIPT_ALREADY_USED');
        const now = new Date();
        const claim = await tx.commerceBankReceiptClaim.create({ data: { id: randomUUID(), requestId: request.id, orderId, buyerId,
          operationKeyHash, originalSha256: image.originalSha256, imageSha256: image.imageSha256,
          bytes: file!.buffer.length, width: image.width, height: image.height, createdAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000), processingExpiresAt: new Date(now.getTime() + 300_000) } });
        await this.audit.record({ actorId: buyerId, action: AuditAction.ReceiptClaimSubmitted,
          target: { type: 'commerce_bank_receipt_claim', id: claim.id }, metadata: { orderId, imageDigest: image.imageSha256, synthetic: true } }, tx);
        return { claim, fresh: true };
      });
    } catch (error) {
      if (this.isUniqueError(error)) throw new ConflictException('RECEIPT_ALREADY_USED');
      throw error;
    }
    if (!created.fresh) return this.response(await this.expireProcessing(created.claim));
    let output: Awaited<ReturnType<BankReceiptOcrService['assess']>> | null = null;
    let failure: string | null = null;
    try { await this.storage.put(created.claim.id, image.buffer); }
    catch { failure = 'PRIVATE_STORAGE_UNAVAILABLE'; }
    if (!failure) {
      try { output = await this.ocr.assess(image.buffer); }
      catch { failure = 'OCR_UNAVAILABLE'; }
    }
    // The provider runs outside the DB transaction; a lease prevents indefinite PROCESSING.
    try {
      const result = await this.finalize(created.claim.id, output, failure);
      return this.response(result);
    } catch (error) {
      // Two different orders may race to submit the same bank code. Preserve both claims,
      // but only the first can reserve the replay key; the second requires human review.
      if (!this.isUniqueError(error)) throw error;
      return this.response(await this.finalize(created.claim.id, output, failure, true));
    }
  }

  async listOwned(buyerId: string, orderId: string) {
    this.assertBuyerEnabled(buyerId);
    await this.serializable(tx => this.ownedOrder(tx, buyerId, orderId));
    const rows = await this.prisma.commerceBankReceiptClaim.findMany({ where: { buyerId, orderId }, orderBy: { createdAt: 'desc' }, take: 3 });
    return { items: await Promise.all(rows.map(async row => this.response(await this.expireProcessing(row)))) };
  }
  async imageOwned(buyerId: string, receiptId: string): Promise<Buffer> {
    this.assertBuyerEnabled(buyerId);
    const row = await this.prisma.commerceBankReceiptClaim.findUnique({ where: { id: receiptId } });
    if (!row || row.buyerId !== buyerId) throw new NotFoundException('RECEIPT_NOT_FOUND');
    await this.serializable(tx => this.ownedOrder(tx, buyerId, row.orderId));
    return this.readImage(row, buyerId);
  }
  async listAdmin(actorId: string, query: { page: number; pageSize: number }) {
    await this.admin(actorId);
    const page = Math.max(1, Math.min(100_000, Math.floor(query.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize) || 20));
    const [rows, total] = await Promise.all([
      this.prisma.commerceBankReceiptClaim.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.commerceBankReceiptClaim.count(),
    ]);
    return { items: await Promise.all(rows.map(async row => this.response(await this.expireProcessing(row)))), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }
  async detailAdmin(actorId: string, receiptId: string) {
    await this.admin(actorId);
    const row = await this.prisma.commerceBankReceiptClaim.findUnique({ where: { id: receiptId } });
    if (!row) throw new NotFoundException('RECEIPT_NOT_FOUND');
    return this.response(await this.expireProcessing(row));
  }
  async imageAdmin(actorId: string, receiptId: string): Promise<Buffer> {
    await this.admin(actorId);
    const row = await this.prisma.commerceBankReceiptClaim.findUnique({ where: { id: receiptId } });
    if (!row) throw new NotFoundException('RECEIPT_NOT_FOUND');
    return this.readImage(row, actorId);
  }
  async cleanupExpired(): Promise<{ deleted: number }> {
    if (!this.enabled()) return { deleted: 0 };
    const rows = await this.prisma.commerceBankReceiptClaim.findMany({ where: { expiresAt: { lte: new Date() }, imageDeletedAt: null },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: 20 });
    let deleted = 0;
    for (const row of rows) {
      try {
        await this.storage.remove(row.id);
        const marked = await this.serializable(async tx => {
          await this.lock(tx, row.orderId);
          const current = await tx.commerceBankReceiptClaim.findUniqueOrThrow({ where: { id: row.id } });
          if (current.imageDeletedAt) return false;
          await tx.commerceBankReceiptClaim.update({ where: { id: row.id }, data: { imageDeletedAt: new Date() } });
          await this.audit.record({ actorKind: 'SYSTEM', action: AuditAction.ReceiptImageDeleted,
            target: { type: 'commerce_bank_receipt_claim', id: row.id }, metadata: { reasonCode: 'RETENTION_EXPIRED' } }, tx);
          return true;
        });
        if (marked) deleted++;
      } catch { /* Keep metadata unmarked so the bounded cleanup can retry safely. */ }
    }
    return { deleted };
  }

  private async finalize(id: string, output: Awaited<ReturnType<BankReceiptOcrService['assess']>> | null, failure: string | null, duplicate = false) {
    return this.serializable(async tx => {
      const initial = await tx.commerceBankReceiptClaim.findUniqueOrThrow({ where: { id } });
      await this.lock(tx, initial.orderId);
      const row = await tx.commerceBankReceiptClaim.findUniqueOrThrow({ where: { id } });
      if (row.status !== 'PROCESSING') return row;
      const request = await tx.commerceBankTransferRequest.findUniqueOrThrow({ where: { id: row.requestId } });
      const now = new Date();
      let status = 'OCR_FAILED'; let confidence: number | null = null;
      let fieldsJson: Prisma.InputJsonValue | undefined;
      let warnings = [failure ?? 'OCR_UNAVAILABLE']; let transactionKeyHash: string | null = null;
      if (output && !failure) {
        const assessment = assessReceiptClaim({ ...request, amountMinor: request.amountMinor.toString() }, output.fields, now);
        confidence = Number.isFinite(output.confidence) ? Math.max(0, Math.min(100, Math.floor(output.confidence))) : 0;
        fieldsJson = assessment.normalized as unknown as Prisma.InputJsonValue;
        warnings = [...assessment.warnings];
        if (output.warnings.some(warning => warning !== 'OCR_MISSING_TRANSACTION_ID')) warnings.push('OCR_REVIEW_REQUIRED');
        if (confidence < 70) warnings.push('OCR_LOW_CONFIDENCE');
        const order = await tx.commerceOrder.findFirst({ where: { id: row.orderId, buyerId: row.buyerId } });
        if (!order || order.status !== 'pending_payment' || request.expiresAt <= now || !['PENDING', 'UNDER_REVIEW', 'NEEDS_SUPPORT'].includes(request.status)) warnings.push('ORDER_WINDOW_CLOSED');
        if (row.processingExpiresAt <= now) warnings.push('PROCESSING_LEASE_EXPIRED');
        const buyer = await tx.user.findFirst({ where: { id: row.buyerId, status: 'active', deletedAt: null }, select: { id: true } });
        if (!buyer || !receiptSandboxEnabled(this.config.app.nodeEnv, process.env, row.buyerId)) warnings.push('BUYER_NO_LONGER_ELIGIBLE');
        const transactionId = assessment.normalized.transactionId;
        if (transactionId && !warnings.includes('TRANSACTION_ID_INVALID')) {
          transactionKeyHash = digest(JSON.stringify([request.bankBin, request.accountNumber, transactionId]));
          const other = await tx.commerceBankReceiptClaim.findUnique({ where: { transactionKeyHash } });
          if (duplicate || (other && other.id !== row.id)) { warnings.push('TRANSACTION_REUSED'); transactionKeyHash = null; }
        }
        status = assessment.status === 'MATCHED_CLAIM' && warnings.every(w => ['CUSTOMER_IMAGE_NOT_BANK_PROOF', 'TRANSACTION_ID_MISSING'].includes(w)) ? 'MATCHED_CLAIM' : 'REVIEW_REQUIRED';
      }
      const result = await tx.commerceBankReceiptClaim.update({ where: { id }, data: { status, confidence, fieldsJson, warnings, transactionKeyHash, assessedAt: now } });
      await this.audit.record({ actorKind: 'SYSTEM', action: AuditAction.ReceiptClaimAssessed,
        target: { type: 'commerce_bank_receipt_claim', id }, metadata: { status, reasonCodes: warnings, financialProof: false } }, tx);
      return result;
    });
  }
  private async expireProcessing(row: CommerceBankReceiptClaim) {
    if (row.status !== 'PROCESSING' || row.processingExpiresAt > new Date()) return row;
    return this.finalize(row.id, null, 'PROCESSING_INTERRUPTED');
  }
  private async readImage(row: CommerceBankReceiptClaim, actorId: string) {
    if (row.expiresAt <= new Date() || row.imageDeletedAt || row.warnings.includes('PRIVATE_STORAGE_UNAVAILABLE')) throw new NotFoundException('RECEIPT_IMAGE_UNAVAILABLE');
    await this.audit.record({ actorId, action: AuditAction.ReceiptImageViewed,
      target: { type: 'commerce_bank_receipt_claim', id: row.id }, metadata: { synthetic: true } });
    try { return await this.storage.read(row.id); }
    catch { throw new NotFoundException('RECEIPT_IMAGE_UNAVAILABLE'); }
  }
  private response(row: CommerceBankReceiptClaim) {
    return { id: row.id, orderId: row.orderId, requestId: row.requestId, status: row.status, financialProof: false,
      fields: row.fieldsJson, warnings: row.warnings, confidence: row.confidence, createdAt: row.createdAt,
      assessedAt: row.assessedAt, expiresAt: row.expiresAt,
      imageAvailable: !row.imageDeletedAt && row.expiresAt > new Date() && !row.warnings.includes('PRIVATE_STORAGE_UNAVAILABLE') };
  }
  private enabled() {
    return bankTransferEnabled(this.config.app.nodeEnv, process.env.BANK_TRANSFER_SANDBOX_ENABLED) && process.env.BANK_RECEIPT_SANDBOX_ENABLED === 'true';
  }
  private assertBuyerEnabled(buyerId: string) {
    if (!receiptSandboxEnabled(this.config.app.nodeEnv, process.env, buyerId)) throw new ServiceUnavailableException('BANK_RECEIPT_DISABLED');
  }
  private async admin(actorId: string) {
    if (!this.enabled()) throw new ServiceUnavailableException('BANK_RECEIPT_DISABLED');
    const allowed = (process.env.BANK_TRANSFER_SANDBOX_OPERATOR_IDS ?? '').split(',').map(id => id.trim());
    if (!allowed.includes(actorId)) throw new ForbiddenException('RECEIPT_OPERATOR_REQUIRED');
    const user = await this.prisma.user.findFirst({ where: { id: actorId, status: 'active', deletedAt: null,
      roles: { some: { role: { name: 'platform_admin' } } } }, select: { id: true } });
    if (!user) throw new ForbiddenException('RECEIPT_OPERATOR_REQUIRED');
  }
  private async ownedOrder(tx: Prisma.TransactionClient, buyerId: string, orderId: string) {
    await this.lock(tx, orderId);
    const order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId } });
    const buyer = await tx.user.findFirst({ where: { id: buyerId, status: 'active', deletedAt: null }, select: { id: true } });
    if (!order || !buyer) throw new NotFoundException('RECEIPT_NOT_FOUND');
    const request = await tx.commerceBankTransferRequest.findUnique({ where: { orderId } });
    if (!request) throw new NotFoundException('RECEIPT_NOT_FOUND');
    return { order, request };
  }
  private lock(tx: Prisma.TransactionClient, orderId: string) {
    return tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id=${orderId}::uuid FOR UPDATE`);
  }
  private isUniqueError(error: unknown) { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'; }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        const unique = this.isUniqueError(error);
        const cause = error instanceof Error ? (error as Error & { cause?: { kind?: unknown } }).cause : undefined;
        const serialization = (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
          || (error instanceof Error && error.name === 'DriverAdapterError' && cause?.kind === 'TransactionWriteConflict');
        if (!unique && !serialization) throw error;
        // Prisma driver adapters may surface SQLSTATE40001 directly at COMMIT instead of P2034.
        if (attempt === 2) {
          if (unique) throw error; // Preserve the caller's duplicate-claim/transaction handling.
          throw new ConflictException('RECEIPT_CONCURRENT_OPERATION');
        }
      }
    }
    throw new ConflictException('RECEIPT_CONCURRENT_OPERATION');
  }
}
