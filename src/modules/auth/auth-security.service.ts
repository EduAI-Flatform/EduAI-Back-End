import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FIREBASE_ADMIN_SERVICE, type FirebaseAdminVerifier } from '../firebase/firebase-admin.constants';
import { PasswordService } from './password.service';

@Injectable()
export class AuthSecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    @Optional() @Inject(FIREBASE_ADMIN_SERVICE) private readonly firebase?: FirebaseAdminVerifier,
  ) {}

  async capabilities(userId: string) {
    const user = await this.findActiveUser(userId);
    return { passwordMode: user.firebaseUid ? 'firebase' : user.authProvider === 'local' ? 'local' : 'external', firebaseUid: user.firebaseUid };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (Buffer.byteLength(newPassword, 'utf8') > 72) throw new BadRequestException('Password exceeds 72 UTF-8 bytes.');
    const user = await this.findActiveUser(userId);
    if (user.firebaseUid || user.authProvider !== 'local') throw new ForbiddenException('Password is managed by the account authentication provider.');
    if (!user.passwordHash || !await this.passwords.comparePassword(currentPassword, user.passwordHash)) throw new UnauthorizedException('Current password is incorrect.');
    const passwordHash = await this.passwords.hashPassword(newPassword);
    await this.prisma.$transaction(async tx => {
      const changed = await tx.user.updateMany({
        where: { id: userId, passwordHash: user.passwordHash, firebaseUid: null, authProvider: 'local', status: 'active' },
        data: { passwordHash },
      });
      if (changed.count !== 1) throw new ConflictException('Account credentials changed. Please sign in again.');
      await this.revoke(tx, userId, 'AUTH_PASSWORD_CHANGED');
    });
    return { changed: true, reauthenticate: true };
  }

  async revokeFirebaseSessions(userId: string, idToken: string) {
    const user = await this.findActiveUser(userId);
    if (!this.firebase || !user.firebaseUid) throw new ForbiddenException('Firebase password authentication is unavailable.');
    let claims;
    try { claims = await this.firebase.verifyIdToken(idToken); } catch { throw new UnauthorizedException('Recent password authentication required.'); }
    const age = Date.now() / 1000 - claims.auth_time;
    if (claims.uid !== user.firebaseUid || claims.firebase?.sign_in_provider !== 'password' || !Number.isFinite(age) || age < -30 || age > 300) {
      throw new UnauthorizedException('Recent password authentication required.');
    }
    await this.prisma.$transaction(async tx => {
      const latest = await tx.user.findUnique({ where: { id: userId }, select: { firebaseUid: true, status: true } });
      if (!latest || latest.firebaseUid !== claims.uid || latest.status !== 'active') throw new UnauthorizedException('Account changed. Please sign in again.');
      await this.revoke(tx, userId, 'AUTH_PROVIDER_PASSWORD_CHANGED');
    });
    return { reauthenticate: true };
  }

  private async findActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, passwordHash: true, firebaseUid: true, authProvider: true, status: true } });
    if (!user || user.status !== 'active') throw new UnauthorizedException('Account unavailable.');
    return user;
  }

  private async revoke(tx: Prisma.TransactionClient, userId: string, action: string) {
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: userId, actorKind: 'USER', action, targetType: 'user', targetId: userId, metadataJson: {} } });
  }
}
