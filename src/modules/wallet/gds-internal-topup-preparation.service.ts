import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GdsWalletInvariantError } from './gds-wallet.domain';
import { GDS_UNBOUND_RECEIVING_ACCOUNT_HASH, GdsPayosTopupIntent, buildGdsPayosTopupRequest, GdsPayosTopupRequest } from './gds-payos-topup.domain';
import { lockGdsPayosOrderNamespace } from './gds-payos-order-namespace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
// Fits eight base36 characters after the "G" prefix in the nine-character
// transfer memo. The lower bound is 1; 36^8 is excluded.
const MAX_EXCLUSIVE_ORDER_CODE = 36 ** 8;

export type PrepareGdsTopup = {
  buyerId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  expiresAt: Date;
  urls: { returnUrl: string; cancelUrl: string };
};

export type PreparedGdsTopup = {
  intent: GdsPayosTopupIntent;
  /** Server-only PayOS SDK input; no payment link or QR is created here. */
  payosRequest: GdsPayosTopupRequest | null;
};

/**
 * Persist a unique, idempotent topup intent BEFORE the PayOS SDK call.
 * A prepared intent carries an explicitly unbound recipient hash. The
 * authenticated PayOS SDK response binds the actual recipient exactly once
 * in the same transaction that persists the PayOS payment link.
 */
@Injectable()
export class GdsInternalTopupPreparationService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  async prepare(input: PrepareGdsTopup): Promise<PreparedGdsTopup> {
    if (!this.config.gdsWallet.sandboxEnabled ||
        this.config.app.nodeEnv === 'production' || this.config.app.deploymentClass === 'production') {
      throw new ForbiddenException('GDS topup preparation is unavailable');
    }
    if (!UUID.test(input.buyerId) || !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
        typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n ||
        input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
        !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) ||
        !this.config.commerce.idempotencySecret) {
      throw new GdsWalletInvariantError('GDS_TOPUP_PREPARATION_INVALID_INPUT');
    }
    const requestKeyHash = createHmac('sha256', this.config.commerce.idempotencySecret)
      .update(`gds-internal-topup:${input.idempotencyKey}`, 'utf8').digest('hex');

    const action = () => this.prisma.$transaction(async (tx) => {
      // This global advisory mutex is shared with Commerce PayOS *inside*
      // both serializable transactions. It also serializes two GDS requests
      // whose randomly allocated order codes happen to collide.
      await lockGdsPayosOrderNamespace(tx);
      const previous = await tx.gdsInternalTopup.findUnique({
        where: { buyerId_requestKeyHash: { buyerId: input.buyerId, requestKeyHash } },
      });
      if (previous) {
        if (previous.amountMinor !== input.amountMinor || previous.currency !== 'VND') {
          throw new GdsWalletInvariantError('GDS_TOPUP_IDEMPOTENCY_CONFLICT');
        }
        const intent = this.project(previous);
        // Expiry is immutable for a repeated idempotency key. Retrying after
        // expiry cannot silently mint a new provider order or extend funds.
        if (intent.status === 'CREATED' && intent.expiresAt <= new Date()) {
          throw new GdsWalletInvariantError('GDS_TOPUP_PREPARATION_EXPIRED');
        }
        return { intent, payosRequest: intent.status === 'CREATED'
          ? buildGdsPayosTopupRequest(intent, input.urls) : null };
      }

      const wallet = await tx.gdsInternalWallet.upsert({
        where: { buyerId: input.buyerId }, create: { buyerId: input.buyerId }, update: {},
      });
      if (wallet.status !== 'ACTIVE') throw new GdsWalletInvariantError('GDS_TOPUP_WALLET_SUSPENDED');

      let chosenOrderCode: bigint | null = null;
      for (let index = 0; index < 5; index += 1) {
        const orderCode = BigInt(randomInt(1, MAX_EXCLUSIVE_ORDER_CODE));
        const commerce = await tx.commercePaymentAttempt.findFirst({
          where: { provider: 'payos', providerOrderCode: orderCode }, select: { id: true },
        });
        const walletClaim = await tx.gdsInternalTopup.findUnique({
          where: { payosOrderCode: orderCode }, select: { id: true },
        });
        const legacyClaim = await tx.buyerWalletPayosTopup.findFirst({
          where: { payosOrderCode: orderCode }, select: { id: true },
        });
        if (!commerce && !walletClaim && !legacyClaim) {
          chosenOrderCode = orderCode;
          break;
        }
      }
      if (!chosenOrderCode) throw new GdsWalletInvariantError('GDS_TOPUP_ORDER_CODE_EXHAUSTED');

      const intent: GdsPayosTopupIntent = {
        id: randomUUID(), buyerId: input.buyerId, amountMinor: input.amountMinor,
        currency: 'VND', payosOrderCode: chosenOrderCode,
        receivingAccountHash: GDS_UNBOUND_RECEIVING_ACCOUNT_HASH, expiresAt: input.expiresAt,
        status: 'CREATED', paymentLinkId: null, collectionReference: null,
        partnerCreditEventId: null,
      };
      const payosRequest = buildGdsPayosTopupRequest(intent, input.urls);
      await tx.gdsInternalTopup.create({ data: {
        id: intent.id, buyerId: intent.buyerId, walletId: wallet.id,
        requestKeyHash, amountMinor: intent.amountMinor, currency: 'VND',
        payosOrderCode: intent.payosOrderCode, transferMemo: payosRequest.description,
        receivingAccountHash: intent.receivingAccountHash, expiresAt: intent.expiresAt,
      } });
      return { intent, payosRequest };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await action(); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue;
        throw error;
      }
    }
    throw new GdsWalletInvariantError('GDS_TOPUP_PREPARATION_RETRY_EXHAUSTED');
  }

  private project(row: {
    id: string; buyerId: string; amountMinor: bigint; currency: string;
    payosOrderCode: bigint; receivingAccountHash: string; expiresAt: Date;
    status: string; paymentLinkId: string | null; collectionReference: string | null;
  }): GdsPayosTopupIntent {
    if (!['CREATED', 'PENDING_PAYOS', 'PAYOS_VERIFIED', 'CREDITED', 'CANCELLED', 'REVIEW'].includes(row.status)) {
      throw new GdsWalletInvariantError('GDS_TOPUP_UNEXPECTED_STATUS');
    }
    if (row.currency !== 'VND') throw new GdsWalletInvariantError('GDS_TOPUP_UNEXPECTED_CURRENCY');
    return { ...row, currency: 'VND',
      status: row.status as GdsPayosTopupIntent['status'], partnerCreditEventId: null };
  }
}
