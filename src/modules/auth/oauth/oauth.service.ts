import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthProvider,
  ExternalProvider,
  RoleName,
  UserStatus,
} from '../../../../generated/prisma/client';
import type { Prisma } from '../../../../generated/prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import {
  AuditAction,
  AuditActionValue,
} from '../../../common/audit/audit.constants';
import { AuditService } from '../../../common/audit/audit.service';
import { AppLoggerService } from '../../../common/logging/app-logger.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import { OAuthCallbackDto } from '../dto/oauth-callback.dto';
import { OAuthExchangeDto } from '../dto/oauth-exchange.dto';
import { OAuthProfileDto } from '../dto/oauth-profile.dto';
import { OAuthStartDto } from '../dto/oauth-start.dto';
import {
  OAuthExchangeResponse,
  OAuthIdentity,
  OAuthProfileRequiredResponse,
  OAuthRegistrationRole,
  OAuthSessionResponse,
  OAuthStateRecord,
  OAuthTicketRecord,
  SocialOAuthProvider,
} from './oauth.types';
import {
  OAuthProviderError,
  OAuthProviderService,
} from './oauth-provider.service';
import { OAuthTransactionStore } from './oauth-transaction.store';
import {
  buildOAuthDiagnosticMetadata,
  isSafeOAuthCode,
} from './oauth-diagnostics';

const PROFILE_TICKET_TTL_SECONDS = 10 * 60;

const OAUTH_MESSAGES = {
  accountAlreadyExists: 'Tài khoản này đã tồn tại. Vui lòng đăng nhập.',
  accountBlocked: 'Tài khoản đã bị khóa.',
  accountLinkRequired:
    'Email này đã được đăng ký. Vui lòng đăng nhập bằng phương thức hiện có trước khi liên kết tài khoản.',
  invalidRedirect: 'Đường dẫn chuyển hướng không được phép.',
  invalidState: 'Phiên xác thực OAuth không hợp lệ hoặc đã được sử dụng.',
  providerCancelled: 'Bạn đã hủy đăng nhập.',
  providerUnavailable: 'Phương thức đăng nhập này hiện chưa sẵn sàng.',
  roleRequired: 'Vui lòng chọn vai trò trước khi tạo tài khoản.',
  ticketInvalid: 'Phiên xác thực đã hết hạn. Vui lòng thử lại.',
} as const;

const OAUTH_USER_SELECT = {
  createdAt: true,
  deletedAt: true,
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
} as const;

const OAUTH_IDENTITY_SELECT = {
  emailVerified: true,
  id: true,
  pendingExpiresAt: true,
  provider: true,
  providerAvatar: true,
  providerEmail: true,
  providerName: true,
  providerUserId: true,
  userId: true,
} as const;

type OAuthUserRecord = Prisma.UserGetPayload<{
  select: typeof OAUTH_USER_SELECT;
}>;

type OAuthWriterClient = Prisma.TransactionClient;

interface AccountResolution {
  kind: 'session' | 'profile';
  displayName?: string;
  externalIdentityId?: string;
  userId?: string;
  role?: OAuthRegistrationRole;
}

@Injectable()
export class OAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
    private readonly transactionStore: OAuthTransactionStore,
    private readonly providerService: OAuthProviderService,
    @Optional() private readonly logger?: AppLoggerService,
  ) {}

  getProviderCapabilities() {
    return this.providerService.getCapabilities();
  }

  async start(
    providerValue: string,
    input: OAuthStartDto,
  ): Promise<{ authorizationUrl: string }> {
    const provider = this.parseProvider(providerValue);
    if (!this.providerService.getCapabilities()[provider]) {
      throw this.providerUnavailableException();
    }

    const mode = input.mode ?? 'login';
    if (mode !== 'login' && mode !== 'register') {
      throw new BadRequestException({
        error: 'OAUTH_MODE_INVALID',
        message: OAUTH_MESSAGES.invalidState,
      });
    }
    const role = this.parseRole(input.role);
    if (mode === 'login' && role) {
      throw new BadRequestException({
        error: 'OAUTH_ROLE_NOT_ALLOWED',
        message: OAUTH_MESSAGES.roleRequired,
      });
    }
    if (mode === 'register' && !role) {
      throw this.roleRequiredException();
    }

    const redirectTo = this.normalizeRedirect(input.redirectTo);
    const state = this.generateOpaqueValue();
    const codeVerifier = provider === 'zalo'
      ? this.generateOpaqueValue()
      : undefined;
    const stateRecord: OAuthStateRecord = {
      provider,
      mode,
      role,
      redirectTo,
      ...(codeVerifier ? { codeVerifier } : {}),
      createdAt: Date.now(),
    };

    try {
      await this.transactionStore.setState(
        state,
        stateRecord,
        this.appConfig.oauth.stateTtlSeconds,
      );
      return {
        authorizationUrl: codeVerifier
          ? this.providerService.buildAuthorizationUrl(provider, state, codeVerifier)
          : this.providerService.buildAuthorizationUrl(provider, state),
      };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      this.rethrowStoreError(error);
      throw this.providerUnavailableException();
    }
  }

  async handleCallback(
    providerValue: string,
    input: OAuthCallbackDto,
  ): Promise<{ redirectUrl: string }> {
    const provider = this.parseProvider(providerValue);
    const state = input.state?.trim();
    if (!state) throw this.invalidStateException();

    let stateRecord: OAuthStateRecord | null;
    try {
      stateRecord = await this.transactionStore.consumeState(state);
    } catch (error) {
      this.logCallbackDiagnostic(provider, 'state_consume', error);
      this.rethrowStoreError(error);
      throw this.callbackFailedException();
    }

    if (!stateRecord || !this.isFreshState(stateRecord)) {
      throw this.invalidStateException();
    }
    if (stateRecord.provider !== provider) {
      await this.recordFailure(provider, 'provider_mismatch');
      throw new BadRequestException({
        error: 'OAUTH_PROVIDER_MISMATCH',
        message: OAUTH_MESSAGES.invalidState,
      });
    }
    if (input.error || !input.code?.trim()) {
      await this.recordFailure(provider, 'provider_cancelled');
      throw new BadRequestException({
        error: 'OAUTH_PROVIDER_CANCELLED',
        message: OAUTH_MESSAGES.providerCancelled,
      });
    }

    let identity: OAuthIdentity;
    try {
      identity = await this.providerService.resolveIdentity(
        provider,
        input.code.trim(),
        stateRecord.codeVerifier,
      );
    } catch (error) {
      this.logCallbackDiagnostic(
        provider,
        error instanceof OAuthProviderError ? error.stage : 'provider_identity',
        error,
      );
      const code =
        error instanceof OAuthProviderError
          ? error.code
          : 'OAUTH_CALLBACK_FAILED';
      await this.recordFailure(provider, code);
      throw new BadRequestException({
        error: code,
        message: 'Không thể xác thực với nhà cung cấp. Vui lòng thử lại.',
      });
    }

    let resolution: AccountResolution;
    try {
      resolution = await this.resolveAccount(provider, identity, stateRecord);
    } catch (error) {
      this.logCallbackDiagnostic(provider, 'account_resolution', error);
      if (this.isKnownOAuthException(error)) throw error;
      if (this.isUniqueConflict(error, 'email')) {
        await this.recordFailure(
          provider,
          'email_collision',
          undefined,
          AuditAction.SocialAccountLinkFailed,
        );
        throw this.accountLinkRequiredException();
      }
      if (this.isUniqueConflict(error, 'provider_user_id')) {
        await this.recordFailure(
          provider,
          'external_identity_collision',
          undefined,
          AuditAction.SocialAccountLinkFailed,
        );
        throw this.accountAlreadyExistsException();
      }
      await this.recordFailure(provider, 'account_resolution_failed');
      throw error;
    }

    const ticket = this.generateOpaqueValue();
    try {
      await this.transactionStore.setTicket(
        ticket,
        {
          kind: resolution.kind,
          mode: stateRecord.mode,
          provider,
          redirectTo: stateRecord.redirectTo,
          ...(resolution.externalIdentityId
            ? { externalIdentityId: resolution.externalIdentityId }
            : {}),
          ...(resolution.userId ? { userId: resolution.userId } : {}),
          ...(resolution.role ? { role: resolution.role } : {}),
          ...(resolution.displayName
            ? { displayName: resolution.displayName }
            : {}),
          expiresAt: Date.now() + this.appConfig.oauth.ticketTtlSeconds * 1000,
        },
        this.appConfig.oauth.ticketTtlSeconds,
      );
    } catch (error) {
      this.logCallbackDiagnostic(provider, 'ticket_store', error);
      this.rethrowStoreError(error);
      throw this.callbackFailedException();
    }

    return { redirectUrl: this.buildFrontendRedirect({ ticket, provider }) };
  }

  buildErrorRedirect(providerValue: string, code: string): string {
    const provider = this.parseProvider(providerValue);
    const safeCode = isSafeOAuthCode(code) ? code : 'OAUTH_CALLBACK_FAILED';
    const url = new URL(this.getFrontendCallbackUrl());
    url.searchParams.set('provider', provider);
    url.searchParams.set('error', safeCode);
    return url.toString();
  }

  async exchange(input: OAuthExchangeDto): Promise<OAuthExchangeResponse> {
    const ticket = input.ticket.trim();
    let record: OAuthTicketRecord | null;
    try {
      record = await this.transactionStore.consumeTicket(ticket);
    } catch (error) {
      this.rethrowStoreError(error);
      throw this.ticketInvalidException();
    }

    if (!record || record.expiresAt <= Date.now()) {
      throw this.ticketInvalidException();
    }
    if (record.kind === 'profile') {
      if (!record.externalIdentityId) throw this.ticketInvalidException();
      const nextTicket = this.generateOpaqueValue();
      const nextRecord = {
        ...record,
        expiresAt: Date.now() + PROFILE_TICKET_TTL_SECONDS * 1000,
      };
      try {
        await this.transactionStore.setTicket(
          nextTicket,
          nextRecord,
          PROFILE_TICKET_TTL_SECONDS,
        );
      } catch (error) {
        this.rethrowStoreError(error);
        throw this.ticketInvalidException();
      }
      const response: OAuthProfileRequiredResponse = {
        kind: 'profile_required',
        provider: record.provider,
        ticket: nextTicket,
        redirectTo: record.redirectTo,
        ...(record.displayName ? { displayName: record.displayName } : {}),
      };
      return response;
    }

    if (!record.userId) throw this.ticketInvalidException();

    const response = await this.prisma.$transaction(async (tx) => {
      const user = await this.findUserById(tx, record.userId as string);
      this.assertActiveUser(user);
      const session = await this.authService.issueSessionForUser(user, tx);
      await this.recordSuccess(record.provider, user.id, tx);
      return session;
    });

    const result: OAuthSessionResponse = {
      kind: 'session',
      session: response,
      redirectTo: record.redirectTo,
    };
    return result;
  }

  async completeProfile(input: OAuthProfileDto): Promise<OAuthSessionResponse> {
    return this.completeProfileWithTicket(input.ticket, input);
  }

  async completeProfileWithTicket(
    ticketValue: string,
    input: OAuthProfileDto,
  ): Promise<OAuthSessionResponse> {
    const email = input.email.trim().toLowerCase();
    if (!this.isValidEmail(email)) {
      throw new BadRequestException({
        error: 'INVALID_EMAIL',
        message: 'Địa chỉ email không hợp lệ.',
      });
    }

    const record = await this.consumeProfileTicket(ticketValue);
    if (!record.externalIdentityId) throw this.ticketInvalidException();

    return this.prisma.$transaction(async (tx) => {
      const external = await tx.externalIdentity.findUnique({
        where: { id: record.externalIdentityId as string },
        select: OAUTH_IDENTITY_SELECT,
      });
      if (
        !external ||
        external.provider !== this.toExternalProvider(record.provider) ||
        external.userId ||
        !external.pendingExpiresAt ||
        external.pendingExpiresAt.getTime() <= Date.now()
      ) {
        throw this.ticketInvalidException();
      }

      if (record.mode === 'register' && !record.role) {
        throw this.roleRequiredException();
      }

      const existingUser = await tx.user.findUnique({
        where: { email },
        select: OAUTH_USER_SELECT,
      });
      if (existingUser) {
        await this.recordFailure(
          record.provider,
          'email_collision',
          tx,
          AuditAction.SocialAccountLinkFailed,
        );
        throw this.accountLinkRequiredException();
      }

      const role = record.role ?? RoleName.student;
      const user = await this.createLinkedUser(
        tx,
        record.provider,
        {
          providerUserId: external.providerUserId,
          email,
          emailVerified: false,
          fullName:
            input.fullName?.trim() ||
            external.providerName?.trim() ||
            `Người dùng ${record.provider === 'facebook' ? 'Facebook' : 'Zalo'}`,
          avatarUrl: external.providerAvatar ?? undefined,
        },
        role,
        external.id,
      );
      const session = await this.authService.issueSessionForUser(user, tx);
      await this.recordSuccess(record.provider, user.id, tx);
      return { kind: 'session', session, redirectTo: record.redirectTo };
    });
  }

  private async resolveAccount(
    provider: SocialOAuthProvider,
    identity: OAuthIdentity,
    state: OAuthStateRecord,
  ): Promise<AccountResolution> {
    return this.prisma.$transaction(async (tx) => {
      const externalProvider = this.toExternalProvider(provider);
      const existingExternal = await tx.externalIdentity.findUnique({
        where: {
          provider_providerUserId: {
            provider: externalProvider,
            providerUserId: identity.providerUserId,
          },
        },
        select: OAUTH_IDENTITY_SELECT,
      });

      if (existingExternal?.userId) {
        if (state.mode === 'register') {
          throw this.accountAlreadyExistsException();
        }
        const user = await this.findUserById(tx, existingExternal.userId);
        this.assertActiveUser(user);
        return { kind: 'session', userId: user.id };
      }

      if (identity.email) {
        const existingUser = await tx.user.findUnique({
          where: { email: identity.email },
          select: OAUTH_USER_SELECT,
        });
        if (existingUser) {
          await this.recordFailure(
            provider,
            'email_collision',
            tx,
            AuditAction.SocialAccountLinkFailed,
          );
          throw this.accountLinkRequiredException();
        }

        const role = this.resolveRole(state);
        const user = await this.createLinkedUser(
          tx,
          provider,
          identity,
          role,
          existingExternal?.id,
        );
        return { kind: 'session', userId: user.id };
      }

      const pendingExpiresAt = new Date(
        Date.now() + PROFILE_TICKET_TTL_SECONDS * 1000,
      );
      const pending = existingExternal
        ? await tx.externalIdentity.update({
            where: { id: existingExternal.id },
            data: {
              emailVerified: false,
              pendingExpiresAt,
              providerAvatar: identity.avatarUrl,
              providerName: identity.fullName,
            },
            select: { id: true },
          })
        : await tx.externalIdentity.create({
            data: {
              emailVerified: false,
              pendingExpiresAt,
              provider: externalProvider,
              providerAvatar: identity.avatarUrl,
              providerEmail: null,
              providerName: identity.fullName,
              providerUserId: identity.providerUserId,
              userId: null,
            },
            select: { id: true },
          });

      return {
        kind: 'profile',
        displayName: identity.fullName,
        externalIdentityId: pending.id,
        role: state.role,
      };
    });
  }

  private async createLinkedUser(
    tx: OAuthWriterClient,
    provider: SocialOAuthProvider,
    identity: OAuthIdentity,
    roleName: OAuthRegistrationRole,
    existingExternalIdentityId?: string,
  ): Promise<OAuthUserRecord> {
    const role = await tx.role.findUnique({
      where: { name: roleName },
      select: { id: true },
    });
    if (!role) {
      throw new InternalServerErrorException('Registration role is missing');
    }

    const created = await tx.user.create({
      data: {
        authProvider: this.toAuthProvider(provider),
        avatarUrl: identity.avatarUrl,
        email: identity.email as string,
        emailVerified: identity.emailVerified,
        fullName: identity.fullName?.trim() || `Người dùng ${provider}`,
      },
      select: { id: true },
    });
    await tx.userRole.create({
      data: { roleId: role.id, userId: created.id },
    });

    if (existingExternalIdentityId) {
      await tx.externalIdentity.update({
        where: { id: existingExternalIdentityId },
        data: {
          emailVerified: identity.emailVerified,
          pendingExpiresAt: null,
          providerAvatar: identity.avatarUrl,
          providerEmail: identity.email,
          providerName: identity.fullName,
          userId: created.id,
        },
      });
    } else {
      await tx.externalIdentity.create({
        data: {
          emailVerified: identity.emailVerified,
          pendingExpiresAt: null,
          provider: this.toExternalProvider(provider),
          providerAvatar: identity.avatarUrl,
          providerEmail: identity.email,
          providerName: identity.fullName,
          providerUserId: identity.providerUserId,
          userId: created.id,
        },
      });
    }

    const user = await this.findUserById(tx, created.id);
    this.assertActiveUser(user);
    await this.auditService.record(
      {
        actorId: user.id,
        action: AuditAction.SocialAccountCreated,
        target: { type: 'user', id: user.id },
        metadata: { provider: this.toExternalProvider(provider) },
      },
      tx,
    );
    return user;
  }

  private async consumeProfileTicket(
    ticketValue: string,
  ): Promise<OAuthTicketRecord> {
    let record: OAuthTicketRecord | null;
    try {
      record = await this.transactionStore.consumeTicket(ticketValue);
    } catch (error) {
      this.rethrowStoreError(error);
      throw this.ticketInvalidException();
    }
    if (
      !record ||
      record.kind !== 'profile' ||
      record.expiresAt <= Date.now()
    ) {
      throw this.ticketInvalidException();
    }
    return record;
  }

  private async findUserById(
    tx: OAuthWriterClient,
    userId: string,
  ): Promise<OAuthUserRecord> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: OAUTH_USER_SELECT,
    });
    if (!user) throw this.ticketInvalidException();
    return user;
  }

  private assertActiveUser(user: OAuthUserRecord): void {
    if (user.status !== UserStatus.active || user.deletedAt) {
      throw new ForbiddenException({
        error: 'ACCOUNT_BLOCKED',
        message: OAUTH_MESSAGES.accountBlocked,
      });
    }
  }

  private resolveRole(
    state: OAuthStateRecord,
  ): OAuthRegistrationRole {
    if (state.role === RoleName.student || state.role === RoleName.instructor) {
      return state.role;
    }
    if (state.mode === 'register') throw this.roleRequiredException();
    return RoleName.student;
  }

  private parseProvider(value: string): SocialOAuthProvider {
    if (value === 'facebook' || value === 'zalo') return value;
    throw new BadRequestException({
      error: 'OAUTH_PROVIDER_UNSUPPORTED',
      message: OAUTH_MESSAGES.providerUnavailable,
    });
  }

  private parseRole(value?: string): OAuthRegistrationRole | undefined {
    if (value === RoleName.student || value === RoleName.instructor) {
      return value;
    }
    if (value) throw this.roleRequiredException();
    return undefined;
  }

  private normalizeRedirect(value?: string): string {
    const redirectTo = value?.trim() || '/';
    if (
      redirectTo.length > 200 ||
      !/^\/[A-Za-z0-9/_:-]*$/.test(redirectTo) ||
      redirectTo.startsWith('//') ||
      !this.isAllowlistedRedirect(redirectTo)
    ) {
      throw new BadRequestException({
        error: 'OAUTH_REDIRECT_NOT_ALLOWED',
        message: OAUTH_MESSAGES.invalidRedirect,
      });
    }
    return redirectTo;
  }

  private isAllowlistedRedirect(value: string): boolean {
    return [
      /^\/$/,
      /^\/(?:courses|community|jobs|library|cart|membership|profile|ai|verify)(?:\/[A-Za-z0-9_-]+)*$/,
      /^\/(?:dashboard|instructor\/dashboard|admin\/dashboard)(?:\/[A-Za-z0-9_-]+)*$/,
      /^\/(?:learning|quizzes|assignments|classroom-sessions)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/,
    ].some((pattern) => pattern.test(value));
  }

  private isFreshState(state: OAuthStateRecord): boolean {
    if (
      !Number.isFinite(state.createdAt) ||
      state.createdAt > Date.now() + 30_000 ||
      Date.now() - state.createdAt > this.appConfig.oauth.stateTtlSeconds * 1000
    ) {
      return false;
    }
    if (state.mode !== 'login' && state.mode !== 'register') return false;
    if (state.mode === 'register' && !state.role) return false;
    if (state.provider !== 'facebook' && state.provider !== 'zalo') return false;
    if (
      state.role !== undefined &&
      state.role !== RoleName.student &&
      state.role !== RoleName.instructor
    ) {
      return false;
    }
    if (
      state.provider === 'zalo' &&
      !this.isCodeVerifierValid(state.codeVerifier)
    ) {
      return false;
    }
    if (state.provider === 'facebook' && state.codeVerifier !== undefined) {
      return false;
    }
    try {
      return this.normalizeRedirect(state.redirectTo) === state.redirectTo;
    } catch {
      return false;
    }
  }

  private generateOpaqueValue(): string {
    return randomBytes(32).toString('base64url');
  }

  private isCodeVerifierValid(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
  }

  private getFrontendCallbackUrl(): string {
    const configured = this.appConfig.oauth.frontendCallbackUrl;
    if (configured) return configured;
    const publicAppUrl = this.appConfig.app.publicAppUrl ?? 'http://localhost:5173';
    return `${publicAppUrl.replace(/\/$/, '')}/auth/callback`;
  }

  private buildFrontendRedirect(params: {
    provider: SocialOAuthProvider;
    ticket: string;
  }): string {
    const url = new URL(this.getFrontendCallbackUrl());
    url.searchParams.set('provider', params.provider);
    url.searchParams.set('ticket', params.ticket);
    return url.toString();
  }

  private toExternalProvider(provider: SocialOAuthProvider): ExternalProvider {
    return provider === 'facebook'
      ? ExternalProvider.facebook
      : ExternalProvider.zalo;
  }

  private toAuthProvider(provider: SocialOAuthProvider): AuthProvider {
    return provider === 'facebook' ? AuthProvider.facebook : AuthProvider.zalo;
  }

  private isValidEmail(value: string): boolean {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  private isUniqueConflict(error: unknown, field: string): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== 'P2002' ||
      !('meta' in error)
    ) {
      return false;
    }

    const meta = (error as { meta?: unknown }).meta;
    if (typeof meta !== 'object' || meta === null || !('target' in meta)) {
      return false;
    }

    const target = (meta as { target?: unknown }).target;
    const values = Array.isArray(target)
      ? target.filter((value): value is string => typeof value === 'string')
      : typeof target === 'string'
        ? [target]
        : [];
    const normalizedField = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return values.some((value) => value === field || value === normalizedField || value.includes(field));
  }

  private async recordSuccess(
    provider: SocialOAuthProvider,
    userId: string,
    tx: OAuthWriterClient,
  ): Promise<void> {
    await this.auditService.record(
      {
        actorId: userId,
        action: AuditAction.SocialLoginSucceeded,
        target: { type: 'user', id: userId },
        metadata: { provider: this.toExternalProvider(provider) },
      },
      tx,
    );
  }

  private async recordFailure(
    provider: SocialOAuthProvider,
    reason: string,
    tx?: OAuthWriterClient,
    action: AuditActionValue = AuditAction.SocialLoginFailed,
  ): Promise<void> {
    const input = {
      action,
      target: { type: 'oauth_provider', id: provider },
      metadata: {
        provider: this.toExternalProvider(provider),
        reason: reason.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 64),
      },
    } as const;
    try {
      await this.auditService.record(input, tx);
    } catch {
      // A provider failure must not expose an audit/database failure.
    }
  }

  private logCallbackDiagnostic(
    provider: SocialOAuthProvider,
    stage: string,
    error: unknown,
  ): void {
    if (this.isKnownOAuthException(error)) return;

    this.logger?.error(
      'OAuth callback failed',
      'OAuthCallback',
      buildOAuthDiagnosticMetadata(provider, stage, error),
    );
  }

  private isKnownOAuthException(error: unknown): boolean {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof UnauthorizedException ||
      error instanceof ServiceUnavailableException
    ) {
      return true;
    }
    return false;
  }

  private rethrowStoreError(error: unknown): void {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'OAUTH_STATE_STORE_UNAVAILABLE'
    ) {
      throw new ServiceUnavailableException({
        error: 'OAUTH_STATE_STORE_UNAVAILABLE',
        message: 'Hệ thống đăng nhập tạm thời chưa sẵn sàng.',
      });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'OAUTH_STATE_INVALID'
    ) {
      throw this.invalidStateException();
    }
  }

  private providerUnavailableException(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      error: 'OAUTH_PROVIDER_UNAVAILABLE',
      message: OAUTH_MESSAGES.providerUnavailable,
    });
  }

  private callbackFailedException(): BadRequestException {
    return new BadRequestException({
      error: 'OAUTH_CALLBACK_FAILED',
      message: 'KhÃ´ng thá»ƒ hoÃ n táº¥t xÃ¡c thá»±c. Vui lÃ²ng thá»­ láº¡i.',
    });
  }

  private roleRequiredException(): ConflictException {
    return new ConflictException({
      error: 'ACCOUNT_ROLE_REQUIRED',
      message: OAUTH_MESSAGES.roleRequired,
    });
  }

  private invalidStateException(): BadRequestException {
    return new BadRequestException({
      error: 'OAUTH_STATE_INVALID',
      message: OAUTH_MESSAGES.invalidState,
    });
  }

  private ticketInvalidException(): UnauthorizedException {
    return new UnauthorizedException({
      error: 'OAUTH_TICKET_INVALID',
      message: OAUTH_MESSAGES.ticketInvalid,
    });
  }

  private accountAlreadyExistsException(): ConflictException {
    return new ConflictException({
      error: 'ACCOUNT_ALREADY_EXISTS',
      message: OAUTH_MESSAGES.accountAlreadyExists,
    });
  }

  private accountLinkRequiredException(): ConflictException {
    return new ConflictException({
      error: 'SOCIAL_ACCOUNT_LINK_REQUIRED',
      message: OAUTH_MESSAGES.accountLinkRequired,
    });
  }
}
