import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { createVietQrPayload } from '../payments/bank-transfer-policy';
import { GdsBankCatalogueService } from './gds-bank-catalogue.service';
import { GdsBankLookupProvider } from './gds-bank-provider';
import { normalizeBankAccountName, sameBankAccountName, verificationMatches } from './gds-account-verification.domain';

@Injectable()
export class GdsAccountVerificationService {
  constructor(private readonly prisma: PrismaService, private readonly banks: GdsBankCatalogueService, private readonly provider: GdsBankLookupProvider) {}
  available() { return this.provider.isAvailable(); }

  async verify(ownerId: string, bankCode: string, accountNumber: string) {
    this.requireQrAccount(accountNumber);
    const bank = await this.banks.get(bankCode);
    if (!this.provider.available(bank.bin) || !bank.lookupSupported) throw new ServiceUnavailableException('GDS_ACCOUNT_VERIFICATION_UNAVAILABLE');
    const result = await this.provider.lookup(bank.bin, accountNumber);
    const verifiedAt = new Date();
    return this.prisma.gdsAccountVerification.create({ data: {
      ownerId, actorId: ownerId, bankCode: bank.code, bankBin: bank.bin, bankName: bank.name, bankShortName: bank.shortName,
      accountNumber, accountHolder: result.accountHolder, normalizedAccountHolder: normalizeBankAccountName(result.accountHolder),
      provider: result.provider, providerReference: result.providerReference, purpose: 'CREATE', verifiedAt, expiresAt: new Date(verifiedAt.getTime()+15*60*1000),
    } }).then(publicVerification);
  }

  /** Called inside the money transaction; no network or provider work occurs here. */
  async resolve(tx: Prisma.TransactionClient, ownerId: string, bankCode: string, accountNumber: string, verificationId: string) {
    const proof = await tx.gdsAccountVerification.findUnique({ where: { id: verificationId } });
    if (!proof || !verificationMatches(proof, ownerId, bankCode, accountNumber)) throw new ConflictException('GDS_ACCOUNT_VERIFICATION_INVALID_OR_EXPIRED');
    return proof;
  }

  /** Live beneficiary lookup before a transfer claim, outside any financial row lock. */
  async verifyTransfer(actorId: string, id: string) {
    const row = await this.prisma.gdsWithdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
    if (row.ownerId === actorId) throw new ForbiddenException('GDS_WITHDRAWAL_SELF_PROCESSING_FORBIDDEN');
    if (!['PENDING','APPROVED','PROCESSING'].includes(row.status)) throw new ConflictException('GDS_WITHDRAWAL_INVALID_TRANSITION');
    if (row.status === 'PROCESSING' && row.processingAdminId !== actorId) throw new ForbiddenException('GDS_WITHDRAWAL_CLAIMED_BY_ANOTHER_ADMIN');
    this.requireQrAccount(row.accountNumber);
    const bank = await this.banks.get(row.bankBin ?? row.bankCode);
    if (!this.provider.available(bank.bin) || !bank.lookupSupported) throw new ServiceUnavailableException('GDS_ACCOUNT_VERIFICATION_UNAVAILABLE');
    const result = await this.provider.lookup(bank.bin, row.accountNumber);
    if (!sameBankAccountName(row.accountHolder, result.accountHolder)) throw new ConflictException('GDS_ACCOUNT_HOLDER_MISMATCH');
    const verifiedAt = new Date();
    const proof = await this.prisma.gdsAccountVerification.create({ data: {
      ownerId: row.ownerId, actorId, bankCode: row.bankCode, bankBin: bank.bin, bankName: bank.name, bankShortName: bank.shortName,
      accountNumber: row.accountNumber, accountHolder: result.accountHolder, normalizedAccountHolder: normalizeBankAccountName(result.accountHolder),
      provider: result.provider, providerReference: result.providerReference, purpose: 'TRANSFER', withdrawalId: id,
      verifiedAt, expiresAt: new Date(verifiedAt.getTime()+15*60*1000),
    } });
    return { ...publicVerification(proof), status: 'VERIFIED' as const, withdrawalId: id };
  }

  async qr(actorId: string, id: string) {
    const row = await this.prisma.gdsWithdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('GDS_WITHDRAWAL_NOT_FOUND');
    if (row.status !== 'PROCESSING' || row.processingAdminId !== actorId || row.ownerId === actorId) throw new ForbiddenException('GDS_WITHDRAWAL_QR_NOT_ALLOWED');
    const proof = await this.prisma.gdsAccountVerification.findFirst({ where: {
      withdrawalId: id, actorId, ownerId: row.ownerId, bankCode: row.bankCode, accountNumber: row.accountNumber,
      purpose: 'TRANSFER', expiresAt: { gt: new Date() },
    }, orderBy: [{ verifiedAt: 'desc' }, { id: 'desc' }] });
    if (!proof || !sameBankAccountName(proof.accountHolder, row.accountHolder)) throw new ConflictException('GDS_ACCOUNT_VERIFICATION_REQUIRED');
    // Existing QR encoder accepts 6..19 digits; do not silently truncate longer destinations.
    if (!/^\d{6,19}$/.test(row.accountNumber)) throw new ConflictException('GDS_ACCOUNT_QR_UNSUPPORTED');
    const transferContent = `GDSW${id.replace(/-/g,'').slice(0,21).toUpperCase()}`;
    const payload = createVietQrPayload(proof.bankBin, row.accountNumber, row.amountMinor, transferContent);
    const qrCodeDataUrl = await QRCode.toDataURL(payload, { margin: 4, width: 480 });
    // Recheck status after encoding so stale tabs never get a terminal request's QR.
    const fresh = await this.prisma.gdsWithdrawal.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'PROCESSING' || fresh.processingAdminId !== actorId || proof.expiresAt <= new Date()) throw new ConflictException('GDS_WITHDRAWAL_QR_EXPIRED');
    return { withdrawalId: id, bankCode: row.bankCode, bankBin: proof.bankBin, bankName: proof.bankName,
      accountNumber: row.accountNumber, accountHolder: proof.accountHolder, amountMinor: row.amountMinor.toString(), currency: 'VND',
      transferContent, qrCodeDataUrl, verifiedAt: proof.verifiedAt.toISOString(), expiresAt: proof.expiresAt.toISOString() };
  }
  private requireQrAccount(accountNumber: string) {
    if (!/^[0-9]{6,19}$/.test(accountNumber)) throw new BadRequestException('GDS_ACCOUNT_QR_UNSUPPORTED');
  }
}
function publicVerification(proof: { id: string; bankCode: string; accountNumber: string; accountHolder: string; verifiedAt: Date; expiresAt: Date }) {
  return { verificationId: proof.id, bankCode: proof.bankCode, accountNumber: proof.accountNumber, accountHolder: proof.accountHolder,
    verifiedAt: proof.verifiedAt.toISOString(), expiresAt: proof.expiresAt.toISOString() };
}
