import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { payosLinkIssues } from '../payments/payos-link.validation';
import { CreatedPaymentRequest } from '../payments/payment-provider';
import { attachGdsPayosLink, GDS_UNBOUND_RECEIVING_ACCOUNT_HASH, GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';
import { lockGdsPayosOrderNamespace } from './gds-payos-order-namespace';

/**
 * The trusted PayOS SDK caller passes only its normalized result to
 * this internal service. This code never calls PayOS or exposes a public QR
 * API. Only authenticated create facts may establish beneficiary binding.
 */
@Injectable()
export class GdsInternalTopupLinkService {
  private readonly logger = new Logger(GdsInternalTopupLinkService.name);

  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  async attachCreatedLink(topupId: string, created: CreatedPaymentRequest): Promise<{
    paymentLinkId: string;
    checkoutUrl: string;
    qrPayload: string | null;
  }> {
    if (!this.config.gdsWallet.sandboxEnabled ||
        this.config.app.nodeEnv === 'production' || this.config.app.deploymentClass === 'production') {
      throw new ForbiddenException('GDS PayOS link persistence is unavailable');
    }
    const issues = payosLinkIssues(created);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(topupId)) {
      issues.push('invalid_topup_id');
    }
    if (issues.length) {
      // Fixed reason codes only; never serialize SDK data or raw errors.
      this.logger.warn({ event: 'gds_payos_link_rejected', issues });
      throw new GdsWalletInvariantError('GDS_TOPUP_INVALID_PAYOS_LINK');
    }
    const receivingAccountHash = createHash('sha256').update(created.receivingAccount as string).digest('hex');

    const execute = () => this.prisma.$transaction(async (tx) => {
      await lockGdsPayosOrderNamespace(tx);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_topups WHERE id = ${topupId}::uuid FOR UPDATE`);
      const row = await tx.gdsInternalTopup.findUnique({ where: { id: topupId } });
      if (!row) throw new GdsWalletInvariantError('GDS_TOPUP_INTENT_NOT_FOUND');

      const intent: GdsPayosTopupIntent = {
        id: row.id, buyerId: row.buyerId, amountMinor: row.amountMinor,
        currency: 'VND', payosOrderCode: row.payosOrderCode,
        receivingAccountHash: row.receivingAccountHash, expiresAt: row.expiresAt,
        status: row.status as GdsPayosTopupIntent['status'],
        paymentLinkId: row.paymentLinkId, collectionReference: row.collectionReference,
        partnerCreditEventId: null,
      };
      if (row.currency !== 'VND' || created.providerOrderReference !== row.payosOrderCode.toString() ||
          created.localOrderReference !== Number(row.payosOrderCode) ||
          created.amountMinor !== row.amountMinor || created.currency !== 'VND') {
        throw new GdsWalletInvariantError('GDS_TOPUP_PAYOS_LINK_MISMATCH');
      }
      // Bind only when the intent is still CREATED and its bank identity is
      // explicitly unbound. Older intents with a preconfigured hash must
      // continue to match that original immutable beneficiary.
      const firstBinding = intent.status === 'CREATED' &&
        intent.receivingAccountHash === GDS_UNBOUND_RECEIVING_ACCOUNT_HASH;
      const next = attachGdsPayosLink(firstBinding
        ? { ...intent, receivingAccountHash }
        : intent, {
        orderCode: row.payosOrderCode, amountMinor: row.amountMinor,
        currency: 'VND', paymentLinkId: created.providerPaymentIdentity,
        checkoutUrl: created.checkoutUrl, receivingAccountHash,
      });
      const commerce = await tx.commercePaymentAttempt.findFirst({
        where: { provider: 'payos', OR: [
          { providerOrderCode: row.payosOrderCode },
          { providerPaymentIdentity: created.providerPaymentIdentity },
        ] }, select: { id: true },
      });
      const legacy = await tx.buyerWalletPayosTopup.findFirst({
        where: { OR: [
          { payosOrderCode: row.payosOrderCode },
          { payosPaymentLinkId: created.providerPaymentIdentity },
        ] }, select: { id: true },
      });
      if (commerce || legacy) throw new GdsWalletInvariantError('GDS_TOPUP_CROSS_LEDGER_LINK_COLLISION');
      if (next.status === 'PENDING_PAYOS' && intent.status === 'CREATED') {
        await tx.gdsInternalTopup.update({
          where: { id: row.id }, data: {
            status: 'PENDING_PAYOS', paymentLinkId: next.paymentLinkId,
            ...(firstBinding ? { receivingAccountHash } : {}),
          },
        });
      }
      return { paymentLinkId: next.paymentLinkId as string,
        checkoutUrl: created.checkoutUrl, qrPayload: created.qrPayload ?? null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await execute(); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue;
        throw error;
      }
    }
    throw new GdsWalletInvariantError('GDS_TOPUP_LINK_RETRY_EXHAUSTED');
  }
}
