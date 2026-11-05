import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { GdsWithdrawal, Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GdsConfirmRecipientDto, GdsCreateWithdrawalDto, GdsWithdrawalActionDto, GdsWithdrawalPageDto, GdsWithdrawalSettingsDto } from './dto/gds-withdrawal.dto';
import { GdsRevenueWalletService, lockGdsFinance } from './gds-revenue-wallet.service';
import { gdsWalletCapabilities } from './gds-wallet-capabilities';
import { nextWithdrawalStatus, validateWithdrawalAmount, WithdrawalAction } from './gds-withdrawal.domain';
import { GdsAccountVerificationService } from './gds-account-verification.service';

@Injectable()
export class GdsWithdrawalService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService, private readonly revenue: GdsRevenueWalletService,
    @Optional() private readonly accounts?: GdsAccountVerificationService) {}

  async settings() {
    const s = await this.prisma.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
    const capabilities = gdsWalletCapabilities(this.config);
    return { minimumMinor: s.minimumMinor.toString(), maximumMinor: s.maximumMinor.toString(), version: s.version,
      admissionEnabled: s.admissionEnabled && capabilities.processingEnabled,
      processingEnabled: s.processingEnabled && capabilities.processingEnabled,
      accountVerificationRequired: s.accountVerificationRequired ?? false,
      accountVerificationAvailable: this.accounts?.available() ?? false };
  }

  async updateSettings(actorId: string, input: GdsWithdrawalSettingsDto) {
    const minimum = BigInt(input.minimumMinor), maximum = BigInt(input.maximumMinor);
    if (input.accountVerificationRequired === true && !this.accounts?.available()) throw new ForbiddenException('GDS_ACCOUNT_VERIFICATION_UNAVAILABLE');
    if (minimum <= 0n || maximum < minimum || maximum > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException('GDS_WITHDRAWAL_INVALID_LIMITS');
    return this.revenue.transaction(async tx => {
      await lockGdsFinance(tx);
      const changed = await tx.gdsWithdrawalSettings.updateMany({ where: { id: 'global', version: input.version }, data: {
        minimumMinor: minimum, maximumMinor: maximum, version: { increment: 1 },
        admissionEnabled: input.admissionEnabled, processingEnabled: input.processingEnabled,
        ...(input.accountVerificationRequired !== undefined ? { accountVerificationRequired: input.accountVerificationRequired } : {}),
      } });
      if (changed.count !== 1) throw new ConflictException('GDS_WITHDRAWAL_SETTINGS_CHANGED');
      await tx.auditLog.create({ data: { actorId, action: 'gds.withdrawal.settings.changed', targetType: 'gds_withdrawal_settings', targetId: 'global',
        metadataJson: { ...input, version: input.version + 1 } } });
      const saved = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
      const capabilities = gdsWalletCapabilities(this.config);
      return { minimumMinor: saved.minimumMinor.toString(), maximumMinor: saved.maximumMinor.toString(), version: saved.version,
        admissionEnabled: saved.admissionEnabled && capabilities.processingEnabled,
        processingEnabled: saved.processingEnabled && capabilities.processingEnabled,
        accountVerificationRequired: saved.accountVerificationRequired ?? false,
        accountVerificationAvailable: this.accounts?.available() ?? false };
    });
  }

  async create(ownerId: string, input: GdsCreateWithdrawalDto, requestKey?: string) {
    if (!requestKey || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) throw new BadRequestException('GDS_WITHDRAWAL_IDEMPOTENCY_KEY_REQUIRED');
    const hash = createHash('sha256').update(requestKey).digest('hex');
    return this.revenue.transaction(async tx => {
      await lockGdsFinance(tx);
      const existing = await tx.gdsWithdrawal.findUnique({ where: { ownerId_requestKeyHash: { ownerId, requestKeyHash: hash } } });
      if (existing) {
        if (existing.amountMinor.toString() !== input.amountMinor || existing.bankCode !== input.bankCode ||
          existing.accountNumber !== input.accountNumber ||
          (existing.verificationId ? existing.verificationId !== input.verificationId : existing.accountHolder !== input.accountHolder)) throw new ConflictException('GDS_WITHDRAWAL_IDEMPOTENCY_CONFLICT');
        return withdrawalResponse(existing, true);
      }
      this.requireProcessing();
      const settings = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
      if (!settings.admissionEnabled || !settings.processingEnabled) throw new ForbiddenException('GDS_WITHDRAWAL_ADMISSION_DISABLED');
      if (settings.accountVerificationRequired && (!input.verificationId || !this.accounts?.available())) throw new ForbiddenException('GDS_ACCOUNT_VERIFICATION_REQUIRED');
      const proof = input.verificationId && this.accounts ? await this.accounts.resolve(tx, ownerId, input.bankCode, input.accountNumber, input.verificationId) : null;
      if (input.verificationId && !proof) throw new ConflictException('GDS_ACCOUNT_VERIFICATION_INVALID_OR_EXPIRED');
      const accountHolder = proof?.accountHolder ?? input.accountHolder?.trim();
      if (!accountHolder) throw new BadRequestException('GDS_ACCOUNT_HOLDER_REQUIRED');
      if (!proof && !/^[A-Z ]{2,160}$/.test(accountHolder)) throw new BadRequestException('GDS_ACCOUNT_HOLDER_INVALID');
      await this.revenue.syncOwner(tx, ownerId);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_wallets WHERE buyer_id=${ownerId}::uuid FOR UPDATE`);
      const wallet = await tx.gdsInternalWallet.findUnique({ where: { buyerId: ownerId } });
      if (!wallet || wallet.status !== 'ACTIVE' || wallet.debtMinor !== 0n) throw new ConflictException('GDS_WITHDRAWAL_WALLET_OR_DEBT_BLOCKED');
      const amount = validateWithdrawalAmount(input.amountMinor, settings.minimumMinor, settings.maximumMinor, wallet.availableMinor);
      const row = await tx.gdsWithdrawal.create({ data: {
        ownerId, walletId: wallet.id, requestKeyHash: hash, amountMinor: amount,
        bankCode: input.bankCode, accountNumber: input.accountNumber, accountHolder,
        ...(proof ? { verificationId: proof.id, bankBin: proof.bankBin, bankName: proof.bankName, bankShortName: proof.bankShortName, accountVerifiedAt: proof.verifiedAt } : {}),
        settingsVersion: settings.version, minimumMinor: settings.minimumMinor, maximumMinor: settings.maximumMinor,
      } });
      await tx.gdsWithdrawalEvent.create({ data: { withdrawalId: row.id, actorId: ownerId, toStatus: 'PENDING', reason: 'Người dùng tạo yêu cầu rút tiền.' } });
      return withdrawalResponse(row, true);
    });
  }

  async list(query: GdsWithdrawalPageDto, ownerId?: string) {
    this.requireRead();
    const where = { ...(ownerId ? { ownerId } : {}), ...(query.status ? { status: query.status } : {}) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.gdsWithdrawal.count({ where }),
      this.prisma.gdsWithdrawal.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { items: rows.map(row => withdrawalResponse(row)), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  }

  async detail(id: string, ownerId?: string) {
    this.requireRead();
    const row = await this.prisma.gdsWithdrawal.findFirst({ where: { id, ...(ownerId ? { ownerId } : {}) } });
    if (!row) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
    const events = await this.prisma.gdsWithdrawalEvent.findMany({ where: { withdrawalId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { ...withdrawalResponse(row, true), events, ...(!ownerId && this.accounts?.transferCheck ? { recipientCheck: await this.accounts.transferCheck(id) } : {}) };
  }

  async confirmRecipient(actorId: string, id: string, input: GdsConfirmRecipientDto) {
    this.requireRead();
    if (input.confirmed !== true || !input.reason?.trim()) throw new BadRequestException('GDS_MANUAL_CHECK_CONFIRMATION_REQUIRED');
    if (!this.accounts) throw new ForbiddenException('GDS_MANUAL_CHECK_NOT_ALLOWED');
    const bank = await this.accounts.prepareManual(actorId, id); // Catalogue I/O stays outside financial locks.
    return this.revenue.transaction(async tx => {
      await lockGdsFinance(tx);
      const row = await tx.gdsWithdrawal.findFirst({ where: { id } });
      if (!row) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
      if (row.ownerId === actorId) throw new ForbiddenException('GDS_WITHDRAWAL_SELF_PROCESSING_FORBIDDEN');
      if (!['PENDING', 'APPROVED', 'PROCESSING'].includes(row.status)) throw new ConflictException('GDS_WITHDRAWAL_INVALID_TRANSITION');
      if (row.status === 'PROCESSING' && row.processingAdminId !== actorId) throw new ForbiddenException('GDS_WITHDRAWAL_CLAIMED_BY_ANOTHER_ADMIN');
      const settings = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
      if (settings.accountVerificationRequired || row.verificationId) throw new ForbiddenException('GDS_MANUAL_CHECK_NOT_ALLOWED');
      const proof = await this.accounts!.recordManual(tx, actorId, row, bank, input.accountHolder);
      await tx.auditLog.create({ data: { actorId, action: 'gds.withdrawal.recipient.manually_checked', targetType: 'gds_withdrawal', targetId: id,
        metadataJson: { verificationId: proof.id, method: 'MANUAL', reason: input.reason.trim() } } });
      if (row.status === 'PENDING') await tx.gdsWithdrawalEvent.create({ data: { withdrawalId: id, actorId, fromStatus: 'PENDING', toStatus: 'APPROVED', reason: input.reason.trim() } });
      const next = await tx.gdsWithdrawal.findUniqueOrThrow({ where: { id } });
      return { ...withdrawalResponse(next, true), recipientCheck: { method: 'MANUAL' as const, actorId, verifiedAt: proof.verifiedAt.toISOString(), expiresAt: proof.expiresAt.toISOString() } };
    });
  }

  async act(actorId: string, id: string, action: WithdrawalAction, input: GdsWithdrawalActionDto, ownerOnly = false) {
    if (action === 'process' && this.accounts) {
      const pending = await this.prisma.gdsWithdrawal.findUnique({ where: { id } });
      if (!pending) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
      if (pending.ownerId === actorId) throw new ForbiddenException('GDS_WITHDRAWAL_SELF_PROCESSING_FORBIDDEN');
      if (pending.status !== 'APPROVED') throw new ConflictException('GDS_WITHDRAWAL_INVALID_TRANSITION');
      const policy = await this.prisma.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
      if (policy.accountVerificationRequired || pending.verificationId) await this.accounts.verifyTransfer(actorId, id);
    }
    return this.revenue.transaction(async tx => {
      await lockGdsFinance(tx);
      const row = await tx.gdsWithdrawal.findFirst({ where: { id, ...(ownerOnly ? { ownerId: actorId } : {}) } });
      if (!row) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
      if (ownerOnly ? action !== 'cancel' : row.ownerId === actorId) throw new ForbiddenException('GDS_WITHDRAWAL_SELF_PROCESSING_FORBIDDEN');
      const status = nextWithdrawalStatus(row.status, action);
      if (['process','pay','fail'].includes(action)) {
        this.requireProcessing();
        const settings = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.processingEnabled) throw new ForbiddenException('GDS_WITHDRAWAL_PROCESSING_DISABLED');
      }
      if (action === 'process') {
        const policy = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
        if (this.accounts) await this.accounts.requireTransferProof(tx, actorId, row, policy.accountVerificationRequired);
        await this.revenue.syncOwner(tx, row.ownerId);
        const wallet = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: row.walletId } });
        if (wallet.status !== 'ACTIVE' || wallet.debtMinor !== 0n) throw new ConflictException('GDS_WITHDRAWAL_WALLET_OR_DEBT_BLOCKED');
      }
      if (['pay','fail'].includes(action) && row.processingAdminId !== actorId) throw new ForbiddenException('GDS_WITHDRAWAL_CLAIMED_BY_ANOTHER_ADMIN');
      if (action === 'pay') {
        if (!input.bankTransactionRef?.trim() || !input.transferredAt) throw new BadRequestException('GDS_WITHDRAWAL_PAYMENT_PROOF_REQUIRED');
        const when = new Date(input.transferredAt);
        if (!Number.isFinite(when.getTime()) || when < row.createdAt || when > new Date()) throw new BadRequestException('GDS_WITHDRAWAL_INVALID_TRANSFER_TIME');
      } else if (input.bankTransactionRef || input.transferredAt) throw new BadRequestException('GDS_WITHDRAWAL_UNEXPECTED_PAYMENT_PROOF');
      await tx.gdsWithdrawalEvent.create({ data: { withdrawalId: id, actorId, fromStatus: row.status, toStatus: status, reason: input.reason,
        bankTransactionRef: action === 'pay' ? input.bankTransactionRef!.trim() : undefined,
        transferredAt: action === 'pay' ? new Date(input.transferredAt!) : undefined } });
      return { ...withdrawalResponse(await tx.gdsWithdrawal.findUniqueOrThrow({ where: { id } }), true),
        ...(!ownerOnly && this.accounts?.transferCheck ? { recipientCheck: await this.accounts.transferCheck(id, tx) } : {}) };
    });
  }
  private requireRead() { if (!gdsWalletCapabilities(this.config).readEnabled) throw new ForbiddenException('GDS_WALLET_UNAVAILABLE'); }
  private requireProcessing() { if (!gdsWalletCapabilities(this.config).processingEnabled) throw new ForbiddenException('GDS_WITHDRAWAL_UNAVAILABLE'); }
}

function withdrawalResponse(row: GdsWithdrawal, detail = false) {
  const { requestKeyHash: _hash, ...visible } = row;
  return { ...visible, amountMinor: row.amountMinor.toString(), minimumMinor: row.minimumMinor.toString(), maximumMinor: row.maximumMinor.toString(),
    accountNumber: detail ? row.accountNumber : `••••${row.accountNumber.slice(-4)}` };
}
