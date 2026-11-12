import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, UserMfa } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { createRecoveryCodes, decryptMfaSecret, encodeBase32, encryptMfaSecret, matchTotpStep, recoveryDigest } from './mfa-crypto';

export interface MfaClaims { mfaRevision?: number; mfaVerified?: boolean; authTime?: number; }
@Injectable()
export class MfaService {
  constructor(private readonly prisma: PrismaService) {}

  private configuredKey(): Buffer | null {
    const encoded = process.env.GDS_MFA_ENCRYPTION_KEY;
    if (!encoded || !/^[0-9a-fA-F]{64}$/.test(encoded)) return null;
    return Buffer.from(encoded, 'hex');
  }
  private key(): Buffer {
    const key = this.configuredKey();
    if (!key) throw new ServiceUnavailableException('Authenticator security has not been configured.');
    return key;
  }
  async status(userId: string) {
    const state = await this.prisma.userMfa.findUnique({ where: { userId } });
    return { available: Boolean(this.configuredKey()), enabled: state?.enabled ?? false, recoveryCodesRemaining: state?.recoveryCodeHashes.length ?? 0 };
  }
  async claims(userId: string, previous?: MfaClaims): Promise<MfaClaims & { mfaRequired: boolean }> {
    const state = await this.prisma.userMfa.findUnique({ where: { userId } });
    const revision = state?.revision ?? 0;
    const verified = Boolean(state?.enabled && previous?.mfaVerified && previous.mfaRevision === revision);
    return {
      mfaRevision: revision, mfaVerified: verified,
      mfaRequired: Boolean(state?.enabled && !verified),
      authTime: previous?.authTime ?? Math.floor(Date.now() / 1000),
    };
  }
  assertFreshPrimary(authTime: number | undefined) {
    const age = Math.floor(Date.now() / 1000) - (authTime ?? 0);
    if (age < -30 || age > 300) throw new UnauthorizedException('Sign in again before changing authenticator settings.');
  }
  async enroll(userId: string, email: string, authTime: number | undefined) {
    this.assertFreshPrimary(authTime);
    const key = this.key();
    const secret = encodeBase32(randomBytes(20));
    const pendingSecretEncrypted = encryptMfaSecret(secret, key, userId);
    const pendingExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.prisma.$transaction(async tx => {
      await tx.userMfa.upsert({ where: { userId }, create: { userId }, update: {} });
      const result = await tx.userMfa.updateMany({
        where: { userId, enabled: false }, data: { pendingSecretEncrypted, pendingExpiresAt },
      });
      if (result.count !== 1) throw new ConflictException('Authenticator is already enabled.');
    });
    return {
      secret, expiresAt: pendingExpiresAt.toISOString(),
      otpauthUri: 'otpauth://totp/' + encodeURIComponent('GDS:' + email) + '?secret=' + secret + '&issuer=GDS&algorithm=SHA1&digits=6&period=30',
    };
  }
  async confirm(userId: string, code: string, authTime: number | undefined) {
    this.assertFreshPrimary(authTime);
    const key = this.key();
    const state = await this.prisma.userMfa.findUnique({ where: { userId } });
    if (!state || state.enabled || !state.pendingSecretEncrypted || !state.pendingExpiresAt || state.pendingExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Authenticator setup has expired. Start again.');
    }
    const secret = decryptMfaSecret(state.pendingSecretEncrypted, key, userId);
    const step = matchTotpStep(secret, code, Date.now(), null);
    if (step === null) throw new UnauthorizedException('Invalid authenticator code.');
    const recovery = createRecoveryCodes(userId);
    const revision = state.revision + 1;
    await this.prisma.$transaction(async tx => {
      const result = await tx.userMfa.updateMany({
        where: { userId, enabled: false, revision: state.revision, pendingSecretEncrypted: state.pendingSecretEncrypted, pendingExpiresAt: { gt: new Date() } },
        data: { enabled: true, revision, secretEncrypted: encryptMfaSecret(secret, key, userId), pendingSecretEncrypted: null, pendingExpiresAt: null, lastUsedStep: step, recoveryCodeHashes: recovery.hashes, enabledAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictException('Authenticator setup changed. Start again.');
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit(tx, userId, 'MFA_ENABLED');
    });
    return { revision, recoveryCodes: recovery.codes };
  }
  async verify(userId: string, code: string, expectedRevision: number | undefined) {
    this.key();
    return this.prisma.$transaction(async tx => {
      const state = await tx.userMfa.findUnique({ where: { userId } });
      if (!state?.enabled || state.revision !== expectedRevision) throw new UnauthorizedException('Authenticator session changed. Sign in again.');
      await this.consumeProof(tx, state, code);
      return state.revision;
    });
  }
  async disable(userId: string, code: string, authTime: number | undefined) {
    this.assertFreshPrimary(authTime);
    this.key();
    await this.prisma.$transaction(async tx => {
      const state = await tx.userMfa.findUnique({ where: { userId } });
      if (!state?.enabled) throw new BadRequestException('Authenticator is not enabled.');
      await this.consumeProof(tx, state, code);
      const result = await tx.userMfa.updateMany({
        where: { userId, revision: state.revision, enabled: true },
        data: { enabled: false, revision: { increment: 1 }, secretEncrypted: null, pendingSecretEncrypted: null, pendingExpiresAt: null, lastUsedStep: null, recoveryCodeHashes: [], enabledAt: null },
      });
      if (result.count !== 1) throw new ConflictException('Authenticator settings changed.');
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit(tx, userId, 'MFA_DISABLED');
    });
    return { disabled: true as const };
  }
  async regenerateRecoveryCodes(userId: string, code: string, authTime: number | undefined) {
    this.assertFreshPrimary(authTime);
    this.key();
    const recovery = createRecoveryCodes(userId);
    const revision = await this.prisma.$transaction(async tx => {
      const state = await tx.userMfa.findUnique({ where: { userId } });
      if (!state?.enabled) throw new BadRequestException('Authenticator is not enabled.');
      await this.consumeProof(tx, state, code);
      const changed = await tx.userMfa.updateMany({
        where: { userId, revision: state.revision, enabled: true },
        data: { revision: { increment: 1 }, recoveryCodeHashes: recovery.hashes },
      });
      if (changed.count !== 1) throw new ConflictException('Authenticator settings changed.');
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit(tx, userId, 'MFA_RECOVERY_CODES_REPLACED');
      return state.revision + 1;
    });
    return { revision, recoveryCodes: recovery.codes };
  }

  private async consumeProof(tx: Prisma.TransactionClient, state: UserMfa, code: string) {
    let consumed = 0;
    if (/^\d{6}$/.test(code)) {
      if (!state.secretEncrypted) throw new UnauthorizedException('Invalid authenticator code.');
      const secret = decryptMfaSecret(state.secretEncrypted, this.key(), state.userId);
      const step = matchTotpStep(secret, code, Date.now(), state.lastUsedStep);
      if (step === null) throw new UnauthorizedException('Invalid or already used authenticator code.');
      const result = await tx.userMfa.updateMany({
        where: { userId: state.userId, enabled: true, revision: state.revision, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
        data: { lastUsedStep: step },
      });
      consumed = result.count;
    } else {
      if (!/^[A-Fa-f0-9]{6}(?:-[A-Fa-f0-9]{6}){3}$/.test(code.trim())) throw new UnauthorizedException('Invalid recovery code.');
      const hash = recoveryDigest(state.userId, code);
      if (!state.recoveryCodeHashes.includes(hash)) throw new UnauthorizedException('Invalid recovery code.');
      const result = await tx.userMfa.updateMany({
        where: { userId: state.userId, enabled: true, revision: state.revision, recoveryCodeHashes: { equals: state.recoveryCodeHashes } },
        data: { recoveryCodeHashes: state.recoveryCodeHashes.filter(value => value !== hash) },
      });
      consumed = result.count;
    }
    if (consumed !== 1) throw new UnauthorizedException('Code was already used. Try another code.');
  }
  private async audit(tx: Prisma.TransactionClient, userId: string, action: string) {
    await tx.auditLog.create({ data: { actorId: userId, actorKind: 'USER', action, targetType: 'user_mfa', targetId: userId, metadataJson: {} } });
  }
}
