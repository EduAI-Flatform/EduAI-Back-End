import { ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AppConfigService } from '../../config/app-config.service';
import { isPayosLinkIdentity, payosLinkIssues } from '../payments/payos-link.validation';
import { PAYMENT_PROVIDER_REGISTRY } from '../payments/payment-provider';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { GdsInternalTopupPreparationService } from './gds-internal-topup-preparation.service';
import { GdsInternalTopupLinkService } from './gds-internal-topup-link.service';

/**
 * Strictly UAT-only PayOS QR presentation. A payment link can collect real
 * money even if there is no wallet crediting workflow. This endpoint MUST
 * remain gated until finance has approved manual reconciliation/refunds.
 * No webhook, credit, ledger, or settlement writes are performed here.
 */
@Injectable()
export class GdsPayosQrPreviewService {
  private readonly logger = new Logger(GdsPayosQrPreviewService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly preparation: GdsInternalTopupPreparationService,
    private readonly links: GdsInternalTopupLinkService,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: PaymentProviderRegistry,
  ) {}

  async create(buyerId: string, amountMinor: string, idempotencyKey: string | undefined) {
    const { app, gdsWallet, payos } = this.config;
    if (!gdsWallet.sandboxEnabled || !gdsWallet.qrPreviewEnabled ||
        app.nodeEnv === 'production' || app.deploymentClass !== 'uat') {
      throw new ForbiddenException('GDS PayOS QR preview is not available');
    }
    const appUrl = app.publicAppUrl;
    if (payos.environment !== 'production' || !appUrl || !/^https:\/\//.test(appUrl) ||
        !this.config.commerce.idempotencySecret) {
      throw new ServiceUnavailableException('GDS QR configuration is incomplete');
    }
    if (!/^[1-9]\d{0,8}$/.test(amountMinor) ||
        BigInt(amountMinor) < 2_000n || BigInt(amountMinor) > 10_000_000n) {
      throw new ConflictException('GDS_TOPUP_AMOUNT_OUT_OF_RANGE');
    }
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ConflictException('GDS_TOPUP_IDEMPOTENCY_KEY_REQUIRED');
    }

    const page = new URL('/wallet/gds', appUrl);
    const prepared = await this.preparation.prepare({
      buyerId,
      amountMinor: BigInt(amountMinor),
      idempotencyKey,
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      urls: { returnUrl: page.toString(), cancelUrl: page.toString() },
    });
    if (!prepared.payosRequest) {
      // Never create a second payment link under an already-accepted intent.
      throw new ConflictException('GDS_TOPUP_ALREADY_CREATED');
    }
    const request = prepared.payosRequest;
    const provider = this.providers.requireEnabled('payos');
    if (prepared.reused) {
      // A previous process may have reached PayOS even though the local row
      // remains CREATED. Reuse its immutable order code; never issue POST again.
      let existing;
      try {
        existing = await provider.retrievePaymentRequest(String(request.orderCode));
      } catch {
        this.logger.warn({ event: 'gds_payos_recovery_blocked', reason: 'lookup_failed' });
        throw new ServiceUnavailableException('GDS_TOPUP_PAYOS_RECOVERY_UNAVAILABLE');
      }
      if (existing.localOrderReference !== request.orderCode ||
          existing.amountMinor !== BigInt(request.amount) ||
          !isPayosLinkIdentity(existing.providerPaymentIdentity) ||
          existing.status !== 'PENDING' || existing.amountPaidMinor !== 0n ||
          existing.amountRemainingMinor !== BigInt(request.amount) || existing.transactions.length !== 0) {
        this.logger.warn({ event: 'gds_payos_recovery_blocked', reason: 'facts_mismatch' });
        throw new ConflictException('GDS_TOPUP_PAYOS_RECOVERY_MISMATCH');
      }
      // SDK 2.0.5 GET supplies status, not the signed create receipt's currency,
      // accountNumber or QR. A status response cannot authorize first binding.
      this.logger.warn({ event: 'gds_payos_recovery_blocked', reason: 'presentation_facts_unavailable' });
      throw new ConflictException('GDS_TOPUP_RECOVERY_REQUIRES_PAYOS_QR');
    }
    const created = await provider.createPaymentRequest({
      paymentAttemptIdentity: prepared.intent.id,
      providerOrderReference: String(request.orderCode),
      localOrderReference: request.orderCode,
      amountMinor: BigInt(request.amount),
      currency: 'VND',
      description: request.description,
      returnUrls: { success: request.returnUrl, cancel: request.cancelUrl },
      expiresAt: new Date(request.expiredAt * 1000),
    });
    const issues = payosLinkIssues(created);
    if (issues.length) {
      this.logger.warn({ event: 'gds_payos_preview_rejected', issues });
      throw new ServiceUnavailableException('GDS_TOPUP_INVALID_PAYOS_LINK');
    }
    // A bounded SDK string may still exceed QR encoder capacity. Encode before
    // changing the local intent, and never log the payload or encoder error.
    let qrCodeDataUrl: string;
    try {
      qrCodeDataUrl = await QRCode.toDataURL(created.qrPayload as string, {
        errorCorrectionLevel: 'M', margin: 1, width: 320,
      });
    } catch {
      this.logger.warn({ event: 'gds_payos_preview_rejected', issues: ['qr_encoding_failed'] });
      throw new ServiceUnavailableException('GDS_TOPUP_PAYOS_QR_ENCODING_FAILED');
    }
    // PayOS's authenticated create response is the source of its receiving
    // bank account. The link transaction binds that hash once, before a QR
    // can be shown; later signed callbacks/reconciliation must match it.
    const link = await this.links.attachCreatedLink(prepared.intent.id, created);
    if (!link.qrPayload) {
      throw new ServiceUnavailableException('PayOS did not return a bank QR');
    }

    return {
      topupId: prepared.intent.id,
      amountMinor: request.amount.toString(),
      currency: 'VND' as const,
      transferMemo: request.description,
      receivingAccount: created.receivingAccount,
      checkoutUrl: link.checkoutUrl,
      qrCodeDataUrl,
      expiresAt: new Date(request.expiredAt * 1000).toISOString(),
      status: 'AWAITING_TRANSFER' as const,
      gdsCredited: false as const,
    };
  }
}
