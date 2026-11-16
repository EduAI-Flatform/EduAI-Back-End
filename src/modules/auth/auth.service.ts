import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import {
  AuthProvider,
  Prisma,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import {
  FIREBASE_ADMIN_SERVICE,
  type FirebaseAdminVerifier,
} from '../firebase/firebase-admin.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { PasswordService } from './password.service';
import { MfaService, MfaClaims } from './mfa.service';
import { lockActiveAuthSubject, lockAuthSubject } from './auth-subject-lock';
import type { AuthenticatedUser } from './types/authenticated-user.type';
import { assertActiveSession, isSessionPayload, matchesRefreshToken, refreshTokenDigest, SessionIdentity, SessionPayload } from './auth-session';
import {
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
  RegisteredUserResponse,
} from './types/auth-response.types';

const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;
const REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

const EMAIL_PASSWORD_AUTH_ERROR_MESSAGES = {
  accountBlocked: 'Tài khoản đã bị khóa.',
  accountNotFound: 'Tài khoản chưa tồn tại. Vui lòng đăng ký.',
  invalidCredentials: 'Email hoặc mật khẩu không đúng.',
  invalidRegistrationPassword: 'Mật khẩu đăng ký không hợp lệ.',
} as const;

interface JwtPayload extends SessionPayload {
  email?: string;
  roles?: RoleName[];
  mfaRevision?: number;
  mfaVerified?: boolean;
  authTime?: number;
}

interface RefreshTokenWriter extends Pick<Prisma.TransactionClient, '$queryRaw' | 'user' | 'userMfa'> {
  refreshToken: {
    create(input: {
      data: {
        id: string;
        sessionFamilyId: string;
        expiresAt: Date;
        tokenHash: string;
        userId: string;
      };
    }): Promise<unknown>;
  };
}

export interface AuthUserRecord {
  authRevision: number;
  createdAt: Date;
  email: string;
  fullName: string;
  id: string;
  roles: Array<{
    role: {
      name: RoleName;
    };
  }>;
  status: UserStatus;
  updatedAt: Date;
}

interface FirebaseTokenClaims {
  email?: string;
  email_verified?: boolean;
  firebase?: {
    sign_in_provider?: string;
  };
  name?: string;
  picture?: string;
  uid?: string;
}

const FIREBASE_AUTH_ERROR_MESSAGES = {
  accountRoleRequired: 'Account role is required to create a new account.',
  accountAlreadyExists:
    'Tài khoản này đã tồn tại. Vui lòng đăng nhập.',
  accountBlocked: 'Tài khoản đã bị khóa.',
  accountLinkConflict: 'Email này đã được liên kết với tài khoản khác.',
  emailNotVerified:
    'Email chưa được xác minh. Vui lòng kiểm tra hộp thư.',
  firebaseNotConfigured: 'Hệ thống đăng nhập chưa được cấu hình.',
  invalidFirebaseToken: 'Phiên đăng nhập không hợp lệ.',
} as const;

const FIREBASE_USER_SELECT = {
  authRevision: true,
  avatarUrl: true,
  createdAt: true,
  deletedAt: true,
  email: true,
  firebaseUid: true,
  fullName: true,
  id: true,
  roles: {
    select: {
      role: {
        select: {
          name: true,
        },
      },
    },
  },
  status: true,
  updatedAt: true,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly appConfig: AppConfigService,
    private readonly auditService: AuditService,
    @Optional()
    @Inject(FIREBASE_ADMIN_SERVICE)
    private readonly firebaseAdmin?: FirebaseAdminVerifier,
    @Optional() private readonly mfa?: MfaService,
  ) {}

  async login(input: LoginDto): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        authRevision: true,
        createdAt: true,
        deletedAt: true,
        email: true,
        fullName: true,
        id: true,
        passwordHash: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        status: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw this.accountNotFoundException();
    }

    if (user.status !== UserStatus.active || user.deletedAt) {
      throw this.accountBlockedException();
    }

    if (!user.passwordHash) {
      throw this.invalidCredentialsException();
    }

    const provenPasswordHash = user.passwordHash;
    const passwordMatches = await this.passwordService.comparePassword(
      input.password,
      provenPasswordHash,
    );

    if (!passwordMatches) {
      throw this.invalidCredentialsException();
    }

    return this.prisma.$transaction(async (tx) => {
      const response = await this.issueTokenResponse(user, tx, undefined, provenPasswordHash);
      await this.auditService.record(
        {
          actorId: user.id,
          action: AuditAction.AuthLogin,
          target: { type: 'user', id: user.id },
          metadata: { provider: AuthProvider.local },
        },
        tx,
      );
      return response;
    });
  }

  async loginWithFirebase(input: FirebaseLoginDto): Promise<LoginResponse> {
    const token = await this.verifyFirebaseToken(input.idToken);
    const uid = token.uid?.trim();
    const email = token.email?.trim().toLowerCase();
    const provider = token.firebase?.sign_in_provider;

    if (
      !uid ||
      !email ||
      (provider !== 'google.com' && provider !== 'password')
    ) {
      throw this.invalidFirebaseTokenException();
    }

    if (token.email_verified !== true) {
      if (provider === 'password') {
        throw new ForbiddenException({
          error: 'EMAIL_NOT_VERIFIED',
          message: FIREBASE_AUTH_ERROR_MESSAGES.emailNotVerified,
        });
      }

      throw this.invalidFirebaseTokenException();
    }

    if (provider === 'password' && input.mode !== 'register') {
      throw this.invalidFirebaseTokenException();
    }

    if (provider === 'password' && !input.password) {
      throw new BadRequestException({
        error: 'INVALID_REGISTRATION_PASSWORD',
        message: EMAIL_PASSWORD_AUTH_ERROR_MESSAGES.invalidRegistrationPassword,
      });
    }

    if (provider === 'google.com' && input.password) {
      throw this.invalidFirebaseTokenException();
    }

    const fullName = this.getFirebaseFullName(token.name, email);
    const avatarUrl = this.getOptionalValue(token.picture);
    const authProvider =
      provider === 'google.com' ? AuthProvider.google : AuthProvider.local;
    const passwordHash = input.password
      ? await this.passwordService.hashPassword(input.password)
      : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingByFirebaseUid = await tx.user.findUnique({
          where: { firebaseUid: uid },
          select: FIREBASE_USER_SELECT,
        });
        const existingByEmail = await tx.user.findUnique({
          where: { email },
          select: FIREBASE_USER_SELECT,
        });

        if (input.mode === 'register' && (existingByFirebaseUid || existingByEmail)) {
          throw this.accountAlreadyExistsException();
        }

        if (
          existingByFirebaseUid &&
          existingByEmail &&
          existingByFirebaseUid.id !== existingByEmail.id
        ) {
          throw this.accountLinkConflictException();
        }

        if (
          existingByEmail?.firebaseUid &&
          existingByEmail.firebaseUid !== uid
        ) {
          throw this.accountLinkConflictException();
        }

        let existingUser = existingByFirebaseUid ?? existingByEmail;

        if (!existingUser && !input.role) {
          throw this.accountRoleRequiredException();
        }

        if (existingUser) {
          const proofRevision = existingUser.authRevision;
          await lockAuthSubject(tx, existingUser.id);
          existingUser = await tx.user.findUnique({ where: { id: existingUser.id }, select: FIREBASE_USER_SELECT });
          if (!existingUser || (existingUser.firebaseUid && existingUser.firebaseUid !== uid)) {
            throw this.accountLinkConflictException();
          }
          if (existingUser.status !== UserStatus.active || existingUser.deletedAt) {
            throw new ForbiddenException({
              error: 'ACCOUNT_BLOCKED',
              message: FIREBASE_AUTH_ERROR_MESSAGES.accountBlocked,
            });
          }
          if (existingUser.authRevision !== proofRevision) throw new UnauthorizedException('Account credentials changed. Please sign in again.');

          const updateData: {
            authProvider: AuthProvider;
            avatarUrl?: string;
            emailVerified: boolean;
            firebaseUid?: string;
            fullName?: string;
          } = {
            authProvider,
            emailVerified: true,
          };

          if (!existingUser.firebaseUid) {
            updateData.firebaseUid = uid;
          }
          if (!existingUser.fullName.trim() && fullName) {
            updateData.fullName = fullName;
          }
          if (!existingUser.avatarUrl?.trim() && avatarUrl) {
            updateData.avatarUrl = avatarUrl;
          }

          const user = await tx.user.update({
            where: { id: existingUser.id },
            data: updateData,
            select: FIREBASE_USER_SELECT,
          });

          const response = await this.issueTokenResponse(user, tx);
          await this.auditService.record(
            {
              actorId: user.id,
              action: AuditAction.AuthLogin,
              target: { type: 'user', id: user.id },
              metadata: { provider: authProvider },
            },
            tx,
          );
          return response;
        }

        const role = await tx.role.findUnique({
          where: { name: input.role ?? RoleName.student },
          select: { id: true, name: true },
        });

        if (!role) {
          throw new InternalServerErrorException('Registration role is missing');
        }

        const user = await tx.user.create({
          data: {
            gdsInternalWallet: { create: {} },
            authProvider,
            avatarUrl,
            email,
            emailVerified: true,
            firebaseUid: uid,
            fullName,
            passwordHash,
          },
          select: FIREBASE_USER_SELECT,
        });

        await tx.userRole.create({
          data: {
            roleId: role.id,
            userId: user.id,
          },
        });

        const response = await this.issueTokenResponse(
          { ...user, roles: [{ role }] },
          tx,
        );
        await this.auditService.record(
          {
            actorId: user.id,
            action: AuditAction.AuthLogin,
            target: { type: 'user', id: user.id },
            metadata: { provider: authProvider },
          },
          tx,
        );
        return response;
      });
    } catch (error) {
      if (
        input.mode === 'register' &&
        (this.isEmailConflict(error) || this.isUniqueConflict(error, 'firebaseUid'))
      ) {
        throw this.accountAlreadyExistsException();
      }
      if (this.isEmailConflict(error)) {
        throw new ConflictException('Email is already registered');
      }
      if (this.isUniqueConflict(error, 'firebaseUid')) {
        throw this.accountLinkConflictException();
      }

      throw error;
    }
  }

  async refresh(input: RefreshTokenDto): Promise<RefreshResponse> {
    const payload = await this.verifyRefreshToken(input.refreshToken);
    return this.prisma.$transaction(async (tx) => {
      await lockActiveAuthSubject(tx, payload.sub);
      const storedToken = await this.proveRefreshRow(tx, input.refreshToken, payload);
      if (storedToken.revokedAt) throw new UnauthorizedException('Invalid refresh token');
      const user = await tx.user.findUnique({
        where: { id: payload.sub },
        select: {
          createdAt: true,
          authRevision: true,
          email: true,
          fullName: true,
          id: true,
          deletedAt: true,
          roles: {
            select: {
              role: {
                select: {
                  name: true,
                },
              },
            },
          },
          status: true,
          updatedAt: true,
        },
      });

      if (!user || user.status !== UserStatus.active || user.deletedAt || user.authRevision !== payload.authRevision) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const consumed = await tx.refreshToken.updateMany({
        where: { id: storedToken.id, userId: user.id, sessionFamilyId: payload.sid, tokenHash: storedToken.tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return this.issueTokenResponse(user, tx, { ...payload, authTime: payload.authTime ?? 0 });
    });
  }

  async logout(input: RefreshTokenDto): Promise<LogoutResponse> {
    const payload = await this.verifyRefreshToken(input.refreshToken);
    await this.prisma.$transaction(async tx => {
      await lockAuthSubject(tx, payload.sub);
      // Keep revoked predecessors until expiry: they prove logout after rotation.
      // A changed MFA revision must not prevent revoking their own family.
      await this.proveRefreshRow(tx, input.refreshToken, payload);
      await tx.refreshToken.updateMany({ where: { userId: payload.sub, sessionFamilyId: payload.sid, revokedAt: null }, data: { revokedAt: new Date() } });
    });

    return { loggedOut: true };
  }

  async getCurrentUser(userId: string): Promise<RegisteredUserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        status: true,
        updatedAt: true,
      },
    });

    if (!user || user.status !== UserStatus.active) {
      throw new UnauthorizedException('Invalid access token');
    }

    return this.toRegisteredUserResponse(user);
  }

  async issueSessionForUser(
    user: AuthUserRecord,
    refreshTokenWriter: RefreshTokenWriter,
    expectedAuthRevision: number = user.authRevision,
  ): Promise<LoginResponse> {
    return this.issueTokenResponse({ ...user, authRevision: expectedAuthRevision }, refreshTokenWriter);
  }

  private getRequiredJwtSecret(key: 'accessSecret' | 'refreshSecret'): string {
    const secret = this.appConfig.jwt[key];

    if (!secret) {
      throw new InternalServerErrorException('JWT secret is not configured');
    }

    return secret;
  }

  private async verifyFirebaseToken(
    idToken: string,
  ): Promise<FirebaseTokenClaims> {
    if (!this.firebaseAdmin) {
      throw this.firebaseNotConfiguredException();
    }

    try {
      return await this.firebaseAdmin.verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw this.invalidFirebaseTokenException();
    }
  }

  private invalidFirebaseTokenException(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'INVALID_FIREBASE_TOKEN',
      message: FIREBASE_AUTH_ERROR_MESSAGES.invalidFirebaseToken,
    });
  }

  private accountNotFoundException(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'ACCOUNT_NOT_FOUND',
      message: EMAIL_PASSWORD_AUTH_ERROR_MESSAGES.accountNotFound,
    });
  }

  private invalidCredentialsException(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'INVALID_CREDENTIALS',
      message: EMAIL_PASSWORD_AUTH_ERROR_MESSAGES.invalidCredentials,
    });
  }

  private accountBlockedException(): ForbiddenException {
    return new ForbiddenException({
      error: 'ACCOUNT_BLOCKED',
      message: EMAIL_PASSWORD_AUTH_ERROR_MESSAGES.accountBlocked,
    });
  }

  private firebaseNotConfiguredException(): InternalServerErrorException {
    return new InternalServerErrorException({
      error: 'FIREBASE_NOT_CONFIGURED',
      message: FIREBASE_AUTH_ERROR_MESSAGES.firebaseNotConfigured,
    });
  }

  private accountLinkConflictException(): ConflictException {
    return new ConflictException({
      error: 'ACCOUNT_LINK_CONFLICT',
      message: FIREBASE_AUTH_ERROR_MESSAGES.accountLinkConflict,
    });
  }

  private accountAlreadyExistsException(): ConflictException {
    return new ConflictException({
      error: 'ACCOUNT_ALREADY_EXISTS',
      message: FIREBASE_AUTH_ERROR_MESSAGES.accountAlreadyExists,
    });
  }

  private accountRoleRequiredException(): ConflictException {
    return new ConflictException({
      error: 'ACCOUNT_ROLE_REQUIRED',
      message: FIREBASE_AUTH_ERROR_MESSAGES.accountRoleRequired,
    });
  }

  private getFirebaseFullName(name: string | undefined, email: string): string {
    return this.getOptionalValue(name) ?? email.split('@')[0] ?? email;
  }

  private getOptionalValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
  }

  private async verifyRefreshToken(refreshToken: string): Promise<JwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        refreshToken,
        {
          secret: this.getRequiredJwtSecret('refreshSecret'),
        },
      );

      if (!isSessionPayload(payload, 'refresh')) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async proveRefreshRow(tx: Prisma.TransactionClient, token: string, payload: JwtPayload) {
    const row = await tx.refreshToken.findUnique({ where: { id: payload.jti! } });
    if (!row || row.userId !== payload.sub || row.sessionFamilyId !== payload.sid || row.expiresAt <= new Date() || !matchesRefreshToken(token, row.tokenHash))
      throw new UnauthorizedException('Invalid refresh token');
    return row;
  }

  async confirmMfa(user: AuthenticatedUser, code: string) {
    const { proof, session } = await this.completeMfa(user, (mfa, tx) => mfa.confirm(user.id, code, user.authTime, tx));
    return { recoveryCodes: proof.recoveryCodes, session };
  }

  async enrollMfa(user: AuthenticatedUser) {
    return this.withCurrentMfaCaller(user, (mfa, tx) => mfa.enroll(user.id, user.email ?? user.id, user.authTime, tx));
  }

  async disableMfa(user: AuthenticatedUser, code: string) {
    return this.withCurrentMfaCaller(user, (mfa, tx) => mfa.disable(user.id, code, user.authTime, tx));
  }

  private async withCurrentMfaCaller<T>(user: AuthenticatedUser, work: (mfa: MfaService, tx: Prisma.TransactionClient) => Promise<T>) {
    const mfa = this.mfa;
    if (!mfa) throw new UnauthorizedException('Authenticator security is unavailable.');
    mfa.assertFreshPrimary(user.authTime);
    return this.prisma.$transaction(async tx => {
      await lockActiveAuthSubject(tx, user.id);
      await assertActiveSession(tx, user);
      mfa.assertFreshPrimary(user.authTime);
      await mfa.claims(user.id, user, tx);
      return work(mfa, tx);
    });
  }

  async verifyMfa(user: AuthenticatedUser, code: string): Promise<LoginResponse> {
    const { session } = await this.completeMfa(user, async (mfa, tx) => ({ revision: await mfa.verify(user.id, code, user.mfaRevision, tx) }));
    return session;
  }

  async regenerateMfaRecoveryCodes(user: AuthenticatedUser, code: string) {
    const { proof, session } = await this.completeMfa(user, (mfa, tx) => mfa.regenerateRecoveryCodes(user.id, code, user.authTime, tx));
    return { recoveryCodes: proof.recoveryCodes, session };
  }

  private async completeMfa<T extends { revision: number }>(user: AuthenticatedUser,
    consume: (mfa: MfaService, tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.withCurrentMfaCaller(user, async (mfa, tx) => {
      const proof = await consume(mfa, tx);
      const session = await this.issueMfaSession(user, proof.revision, tx);
      return { proof, session };
    });
  }

  private async issueMfaSession(caller: AuthenticatedUser, revision: number, tx: Prisma.TransactionClient): Promise<LoginResponse> {
    const userId = caller.id;
    if (!this.mfa) throw new UnauthorizedException('Authenticator security is unavailable.');
    const user = await tx.user.findUnique({ where: { id: userId }, select: FIREBASE_USER_SELECT });
    const state = await tx.userMfa.findUnique({ where: { userId } });
    if (!user || user.deletedAt || user.status !== UserStatus.active || !state?.enabled || state.revision !== revision) {
      throw new UnauthorizedException('Authenticator session changed. Sign in again.');
    }
    return this.issueTokenResponse(user, tx, { tokenVersion: 2, sid: caller.sid!, authRevision: caller.authRevision!, mfaVerified: true, mfaRevision: revision, authTime: caller.authTime ?? 0 });
  }

  private async issueTokenResponse(
    user: AuthUserRecord,
    refreshTokenWriter: RefreshTokenWriter,
    previousMfa?: MfaClaims & SessionIdentity,
    provenPasswordHash?: string,
  ): Promise<LoginResponse> {
    await lockActiveAuthSubject(refreshTokenWriter, user.id);
    const current = await refreshTokenWriter.user.findUnique({
      where: { id: user.id }, select: { ...FIREBASE_USER_SELECT, passwordHash: true },
    });
    if (!current || current.deletedAt || current.status !== UserStatus.active ||
      !Number.isSafeInteger(current.authRevision) || current.authRevision < 0 ||
      current.authRevision !== user.authRevision ||
      (previousMfa !== undefined && previousMfa.authRevision !== current.authRevision) ||
      (provenPasswordHash !== undefined && current.passwordHash !== provenPasswordHash)) {
      throw new UnauthorizedException('Account credentials changed. Please sign in again.');
    }
    const responseUser = this.toRegisteredUserResponse(current);
    const mfa = this.mfa ? await this.mfa.claims(user.id, previousMfa, refreshTokenWriter) : undefined;
    const payload = {
      tokenVersion: 2 as const,
      sid: previousMfa?.sid ?? randomUUID(),
      authRevision: current.authRevision,
      authTime: previousMfa?.authTime ?? Math.floor(Date.now() / 1000),
      sub: responseUser.id,
      email: responseUser.email,
      roles: responseUser.roles,
      ...(mfa ? { mfaRevision: mfa.mfaRevision, mfaVerified: mfa.mfaVerified, authTime: mfa.authTime } : {}),
    };
    const accessToken = await this.jwtService.signAsync({ ...payload, tokenUse: 'access' }, {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      secret: this.getRequiredJwtSecret('accessSecret'),
    });
    const refreshId = randomUUID();
    const refreshToken = await this.jwtService.signAsync({ ...payload, tokenUse: 'refresh', jti: refreshId }, {
      expiresIn: REFRESH_TOKEN_EXPIRES_IN_SECONDS,
      secret: this.getRequiredJwtSecret('refreshSecret'),
    });
    const refreshTokenHash = refreshTokenDigest(refreshToken);

    await refreshTokenWriter.refreshToken.create({
      data: {
        id: refreshId,
        sessionFamilyId: payload.sid,
        expiresAt: new Date(
          Date.now() + REFRESH_TOKEN_EXPIRES_IN_SECONDS * 1000,
        ),
        tokenHash: refreshTokenHash,
        userId: responseUser.id,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      user: responseUser,
      ...(mfa ? { mfaRequired: mfa.mfaRequired } : {}),
    };
  }

  private toRegisteredUserResponse(
    user: Omit<AuthUserRecord, 'authRevision'>,
  ): RegisteredUserResponse {
    return {
      createdAt: user.createdAt,
      email: user.email,
      fullName: user.fullName,
      id: user.id,
      roles: user.roles.map((userRole) => userRole.role.name),
      status: user.status,
      updatedAt: user.updatedAt,
    };
  }

  private isEmailConflict(error: unknown): boolean {
    return this.isUniqueConflict(error, 'email');
  }

  private isUniqueConflict(error: unknown, field: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002' &&
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'target' in error.meta &&
      Array.isArray(error.meta.target) &&
      error.meta.target.includes(field)
    );
  }
}
