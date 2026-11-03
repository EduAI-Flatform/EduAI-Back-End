import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, GdsInternalPayosInbox, GdsInternalTopup } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, VerifiedPaymentWebhook } from '../payments/payment-provider';
import { GdsInternalJournalService } from './gds-internal-journal.service';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { reconcileSignedGdsPayosTopup } from './gds-payos-reconciliation';
import { GdsWalletInvariantError } from './gds-wallet.domain';
import { isPayosAccount } from '../payments/payos-link.validation';

const MAX_ATTEMPTS = 12;
const BATCH_SIZE = 20;
type InboxWithTopup = GdsInternalPayosInbox & { topup: GdsInternalTopup };

const hashAccount = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const isPrismaRetry = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error &&
    (error.code === 'P2034' || error.code === 'P2002'));

/**
 * PAYW-04E: consumes signed facts from the EXISTING Commerce PayOS webhook.
 * No second merchant webhook URL is installed (which would steal Commerce
 * callbacks). Production is hard OFF, even if a feature flag is mis-set.
 * The durable inbox stores only normalized facts AFTER SDK verification.
 */
@Injectable()
export class GdsPayosInboxService {
  private readonly logger = new Logger(GdsPayosInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly journal: GdsInternalJournalService,
  ) {}

  enabled(): boolean {
    return this.config.gdsWallet.sandboxEnabled &&
      this.config.app.deploymentClass === 'uat' &&
      (this.config.app.nodeEnv === 'test' || this.config.app.nodeEnv === 'development');
  }

  /**
   * Return false ONLY if the order/link belongs to Commerce or is unknown.
   * Signature verification is performed by PaymentWebhookService first.
   */
  async ingestSignedIfWallet(fact: VerifiedPaymentWebhook): Promise<'RECEIVED' | 'DUPLICATE' | 'REVIEW' | null> {
    if (!this.enabled()) return null; // No DB access on production deployments.
    if (fact.provider !== 'payos' || fact.providerCode !== '00' ||
        !Number.isSafeInteger(fact.localOrderReference) || fact.localOrderReference <= 0) return null;

    const topup = await this.prisma.gdsInternalTopup.findFirst({ where: { OR: [
      { payosOrderCode: BigInt(fact.localOrderReference) },
      { paymentLinkId: fact.providerPaymentIdentity },
    ] } });
    if (!topup) return null;
    const receivingAccount = fact.receivingAccount;
    if (!fact.providerEventIdentity || fact.providerEventIdentity !== fact.providerSettlementReference ||
        !fact.providerPaymentIdentity || fact.amountMinor <= 0n || fact.currency !== 'VND' ||
        !isPayosAccount(receivingAccount) ||
        !Number.isFinite(fact.occurredAt?.getTime())) {
      throw new ConflictException('GDS PayOS signed event is malformed');
    }

    const accountHash = hashAccount(receivingAccount);
    const virtualHash = fact.virtualReceivingAccount === undefined ? null : hashAccount(fact.virtualReceivingAccount);
    const wrongIdentity = topup.payosOrderCode !== BigInt(fact.localOrderReference) ||
      fact.providerOrderReference !== topup.payosOrderCode.toString() ||
      topup.paymentLinkId !== fact.providerPaymentIdentity ||
      topup.amountMinor !== fact.amountMinor || topup.currency !== 'VND' ||
      (topup.settlementReceivingAccountHash != null && topup.settlementReceivingAccountHash !== accountHash) ||
      (virtualHash != null && virtualHash !== topup.receivingAccountHash) ||
      fact.occurredAt > topup.expiresAt ||
      fact.occurredAt.getTime() > Date.now() + 5 * 60_000 ||
      ['CREATED', 'CANCELLED', 'REVIEW'].includes(topup.status);

    const attempt = async (): Promise<'RECEIVED' | 'DUPLICATE' | 'REVIEW'> => {
      return this.prisma.$transaction(async (tx) => {
        const previous = await tx.gdsInternalPayosInbox.findUnique({
          where: { providerEventIdentity: fact.providerEventIdentity },
        });
        if (previous) {
          if (previous.topupId !== topup.id || previous.payosOrderCode !== topup.payosOrderCode ||
              previous.paymentLinkId !== fact.providerPaymentIdentity ||
              previous.amountMinor !== fact.amountMinor || previous.currency !== fact.currency ||
              previous.receivingAccount !== receivingAccount ||
              previous.receivingAccountHash !== accountHash ||
              (previous.virtualReceivingAccountHash ?? null) !== virtualHash ||
              previous.occurredAt.getTime() !== fact.occurredAt.getTime()) {
            throw new ConflictException('Conflicting PayOS signed event identity');
          }
          return previous.status === 'REVIEW' ? 'REVIEW' : 'DUPLICATE';
        }
        // One order code or paymentLinkId may never be owned by Commerce too.
        const commerce = await tx.commercePaymentAttempt.findFirst({
          where: { provider: 'payos', OR: [
            { providerOrderCode: topup.payosOrderCode },
            { providerPaymentIdentity: fact.providerPaymentIdentity },
          ] }, select: { id: true },
        });
        const legacy = await tx.buyerWalletPayosTopup.findFirst({
          where: { OR: [
            { payosOrderCode: topup.payosOrderCode },
            { payosPaymentLinkId: fact.providerPaymentIdentity },
            { collectionReference: fact.providerEventIdentity },
          ] }, select: { id: true },
        });
        const review = wrongIdentity || !!commerce || !!legacy;
        await tx.gdsInternalPayosInbox.create({ data: {
          topupId: topup.id, providerEventIdentity: fact.providerEventIdentity,
          payosOrderCode: BigInt(fact.localOrderReference),
          paymentLinkId: fact.providerPaymentIdentity,
          amountMinor: fact.amountMinor, currency: fact.currency,
          receivingAccount, receivingAccountHash: accountHash, virtualReceivingAccountHash: virtualHash,
          occurredAt: fact.occurredAt, signatureVerifiedAt: new Date(),
          ...(review ? { status: 'REVIEW', reviewReason: 'SIGNED_IDENTITY_OR_TERMINAL_CONFLICT' } : {}),
        } });
        return review ? 'REVIEW' : 'RECEIVED';
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    };
    for (let i = 0; i < 3; i += 1) {
      try { return await attempt(); }
      catch (error) { if (isPrismaRetry(error) && i < 2) continue; throw error; }
    }
    throw new GdsWalletInvariantError('GDS_PAYOS_INBOX_RETRY_EXHAUSTED');
  }

  /** Polls unhandled signed facts. Safe under multiple workers: all value
   * transitions and the inbox ACK use one serializable DB transaction. */
  async processPending(): Promise<{ processed: number; reviewed: number; deferred: number }> {
    if (!this.enabled()) return { processed: 0, reviewed: 0, deferred: 0 };
    const candidates = await this.prisma.gdsInternalPayosInbox.findMany({
      where: { status: 'RECEIVED', nextAttemptAt: { lte: new Date() } },
      orderBy: { receivedAt: 'asc' }, take: BATCH_SIZE, select: { id: true },
    });
    const result = { processed: 0, reviewed: 0, deferred: 0 };
    for (const candidate of candidates) {
      const outcome = await this.processOne(candidate.id);
      if (outcome === 'PROCESSED') result.processed += 1;
      else if (outcome === 'REVIEW') result.reviewed += 1;
      else result.deferred += 1;
    }
    return result;
  }

  async processOne(id: string): Promise<'PROCESSED' | 'REVIEW' | 'DEFERRED'> {
    return this.processRecord(id, false);
  }

  /** Explicit bounded recovery of the historical VA/physical identity conflict.
   * The original REVIEW inbox stays immutable; a separate append-only proof
   * resolves it only after a fresh authenticated PayOS reconciliation.
   */
  async processReviewed(id: string): Promise<'PROCESSED' | 'REVIEW' | 'DEFERRED'> {
    return this.processRecord(id, true);
  }

  private eligibleInbox(inbox: { status: string; reviewReason?: string | null }, recovery: boolean): boolean {
    return inbox.status === 'RECEIVED' || (recovery && inbox.status === 'REVIEW' &&
      inbox.reviewReason === 'SIGNED_IDENTITY_OR_TERMINAL_CONFLICT');
  }

  private async processRecord(id: string, recovery: boolean): Promise<'PROCESSED' | 'REVIEW' | 'DEFERRED'> {
    if (!this.enabled()) throw new ForbiddenException('GDS webhook processing disabled');
    const snapshot = await this.prisma.gdsInternalPayosInbox.findUnique({
      where: { id }, include: { topup: true },
    });
    if (!snapshot || !this.eligibleInbox(snapshot, recovery)) return 'DEFERRED';
    if (snapshot.status === 'REVIEW' && snapshot.topup.status === 'CREDITED') return 'DEFERRED';

    try {
      const intent = this.topupIntent(snapshot.topup);
      const fact = this.signedFact(snapshot);
      const { settlement } = await reconcileSignedGdsPayosTopup(intent, fact, {
        provider: this.provider, sandboxEnabled: this.enabled(),
        nodeEnv: this.config.app.nodeEnv, deploymentClass: this.config.app.deploymentClass,
        now: () => new Date(),
      }, snapshot.signatureVerifiedAt);

      const apply = () => this.prisma.$transaction(async (tx) => {
        // Stable lock order for competing workers and credit postings.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_topups WHERE id = ${snapshot.topupId}::uuid FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_payos_inbox WHERE id = ${id}::uuid FOR UPDATE`);
        const inbox = await tx.gdsInternalPayosInbox.findUniqueOrThrow({ where: { id } });
        if (!this.eligibleInbox(inbox, recovery)) return 'DEFERRED' as const;
        const topup = await tx.gdsInternalTopup.findUniqueOrThrow({ where: { id: inbox.topupId } });
        if (topup.status === 'CREDITED') {
          // Covers a retry after committed journal posting. Never post again.
          const journal = await tx.gdsInternalJournal.findUnique({ where: { topupId: topup.id } });
          if (!journal || journal.kind !== 'TOPUP_CREDIT' ||
              journal.collectionReference !== inbox.providerEventIdentity ||
              journal.amountMinor !== inbox.amountMinor || journal.walletId !== topup.walletId ||
              topup.collectionReference !== inbox.providerEventIdentity ||
              !topup.signatureVerifiedAt || !topup.providerReconciledAt) {
            throw new GdsWalletInvariantError('GDS_PAYOS_CREDITED_EVENT_CONFLICT');
          }
        } else {
          if (topup.status !== 'PENDING_PAYOS' && topup.status !== 'PAYOS_VERIFIED') {
            throw new GdsWalletInvariantError('GDS_PAYOS_TOPUP_TERMINAL_CONFLICT');
          }
          if (topup.status === 'PAYOS_VERIFIED' &&
              (topup.collectionReference !== inbox.providerEventIdentity ||
               !topup.signatureVerifiedAt || !topup.providerReconciledAt)) {
            throw new GdsWalletInvariantError('GDS_PAYOS_TOPUP_VERIFICATION_CONFLICT');
          }
          const physicalHash = settlement.settlementReceivingAccountHash;
          if (!physicalHash || physicalHash !== inbox.receivingAccountHash ||
              (topup.settlementReceivingAccountHash != null && topup.settlementReceivingAccountHash !== physicalHash)) {
            throw new GdsWalletInvariantError('GDS_PAYOS_RECEIVING_ACCOUNT_MISMATCH');
          }
          const priorProof = await tx.gdsInternalPayosReconciliation.findUnique({ where: { inboxId: inbox.id } });
          if (priorProof) {
            if (priorProof.topupId !== topup.id || priorProof.providerEventIdentity !== inbox.providerEventIdentity ||
                priorProof.payosOrderCode !== inbox.payosOrderCode || priorProof.paymentLinkId !== inbox.paymentLinkId ||
                priorProof.amountMinor !== inbox.amountMinor || priorProof.currency !== inbox.currency ||
                priorProof.occurredAt.getTime() !== inbox.occurredAt.getTime() ||
                priorProof.signatureVerifiedAt.getTime() !== inbox.signatureVerifiedAt.getTime() ||
                priorProof.qrReceivingAccountHash !== topup.receivingAccountHash ||
                priorProof.settlementReceivingAccountHash !== physicalHash) {
              throw new GdsWalletInvariantError('GDS_PAYOS_RECONCILIATION_PROOF_CONFLICT');
            }
          } else {
            await tx.gdsInternalPayosReconciliation.create({ data: {
              topupId: topup.id, inboxId: inbox.id, providerEventIdentity: inbox.providerEventIdentity,
              payosOrderCode: inbox.payosOrderCode, paymentLinkId: inbox.paymentLinkId,
              amountMinor: inbox.amountMinor, currency: inbox.currency,
              qrReceivingAccountHash: topup.receivingAccountHash, settlementReceivingAccountHash: physicalHash,
              occurredAt: inbox.occurredAt, signatureVerifiedAt: inbox.signatureVerifiedAt,
              providerReconciledAt: settlement.providerReconciledAt,
            } });
          }
          const reconciledAt = priorProof?.providerReconciledAt ?? settlement.providerReconciledAt;
          if (topup.status === 'PENDING_PAYOS') {
            await tx.gdsInternalTopup.update({ where: { id: topup.id }, data: {
              status: 'PAYOS_VERIFIED', collectionReference: inbox.providerEventIdentity,
              settlementReceivingAccountHash: physicalHash,
              signatureVerifiedAt: inbox.signatureVerifiedAt,
              providerReconciledAt: reconciledAt,
            } });
          }
          await this.journal.creditVerifiedTopupInTransaction(
            tx,
            { ...this.topupIntent(topup), settlementReceivingAccountHash: physicalHash, status: 'PAYOS_VERIFIED',
              collectionReference: inbox.providerEventIdentity },
            { ...settlement,
              signatureVerifiedAt: topup.signatureVerifiedAt ?? inbox.signatureVerifiedAt,
              providerReconciledAt: topup.providerReconciledAt ?? reconciledAt },
          );
        }
        if (inbox.status === 'RECEIVED') {
          await tx.gdsInternalPayosInbox.update({ where: { id }, data: {
            status: 'PROCESSED', processedAt: new Date(), attemptCount: { increment: 1 },
          } });
        }
        return 'PROCESSED' as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
      for (let i = 0; i < 3; i += 1) {
        try { return await apply(); }
        catch (error) { if (isPrismaRetry(error) && i < 2) continue; throw error; }
      }
    } catch (error) {
      if (snapshot.status === 'REVIEW') {
        this.logger.warn('GDS PayOS reviewed transfer still requires reconciliation');
        return 'REVIEW';
      }
      if (error instanceof PaymentProviderError && error.retryable || isPrismaRetry(error) ||
          error instanceof GdsWalletInvariantError && error.message === 'GDS_PAYOS_RECONCILIATION_MISMATCH') {
        return this.defer(id);
      }
      const reason = error instanceof GdsWalletInvariantError ? error.message :
        error instanceof PaymentProviderError ? `PAYOS_${error.code}` : 'GDS_PAYOS_PROCESSING_CONFLICT';
      this.logger.warn(`GDS PayOS inbox moved to review: ${reason}`);
      await this.prisma.gdsInternalPayosInbox.updateMany({
        where: { id, status: 'RECEIVED' }, data: { status: 'REVIEW', reviewReason: reason.slice(0, 128),
          attemptCount: { increment: 1 } },
      });
      return 'REVIEW';
    }
    return 'DEFERRED';
  }

  private async defer(id: string): Promise<'DEFERRED' | 'REVIEW'> {
    const prior = await this.prisma.gdsInternalPayosInbox.findUnique({ where: { id } });
    if (!prior || prior.status !== 'RECEIVED') return 'DEFERRED';
    const attempts = prior.attemptCount + 1;
    await this.prisma.gdsInternalPayosInbox.updateMany({
      where: { id, status: 'RECEIVED', attemptCount: prior.attemptCount },
      data: attempts >= MAX_ATTEMPTS
        ? { status: 'REVIEW', reviewReason: 'GDS_PAYOS_RECONCILIATION_RETRY_EXHAUSTED', attemptCount: attempts }
        : { attemptCount: attempts,
          nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 15_000 * 2 ** Math.min(attempts, 8))) },
    });
    return attempts >= MAX_ATTEMPTS ? 'REVIEW' : 'DEFERRED';
  }

  private topupIntent(topup: GdsInternalTopup): GdsPayosTopupIntent {
    return {
      id: topup.id, buyerId: topup.buyerId, amountMinor: topup.amountMinor,
      currency: topup.currency as 'VND', payosOrderCode: topup.payosOrderCode,
      receivingAccountHash: topup.receivingAccountHash, expiresAt: topup.expiresAt,
      settlementReceivingAccountHash: topup.settlementReceivingAccountHash, createdAt: topup.createdAt,
      status: topup.status as GdsPayosTopupIntent['status'],
      paymentLinkId: topup.paymentLinkId, collectionReference: topup.collectionReference,
      partnerCreditEventId: null,
    };
  }

  private signedFact(inbox: InboxWithTopup): VerifiedPaymentWebhook {
    return {
      provider: 'payos', providerCode: '00', responseCode: '00',
      providerOrderReference: inbox.payosOrderCode.toString(),
      localOrderReference: Number(inbox.payosOrderCode),
      providerPaymentIdentity: inbox.paymentLinkId,
      providerSettlementReference: inbox.providerEventIdentity,
      providerEventIdentity: inbox.providerEventIdentity,
      amountMinor: inbox.amountMinor, currency: inbox.currency as 'VND',
      receivingAccount: inbox.receivingAccount, occurredAt: inbox.occurredAt,
      ...(inbox.virtualReceivingAccountHash ? { verifiedVirtualAccountHash: inbox.virtualReceivingAccountHash } : {}),
    };
  }
}
