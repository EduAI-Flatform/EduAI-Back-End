import {
  AuthProvider,
  ExternalProvider,
  RoleName,
  UserStatus,
} from '../../../../generated/prisma/client';
import { OAuthProviderError } from './oauth-provider.service';
import { AppConfigService } from '../../../config/app-config.service';
import { AuditAction } from '../../../common/audit/audit.constants';
import { OAuthProviderService } from './oauth-provider.service';
import {
  OAuthStateStoreError,
  OAuthTransactionStore,
} from './oauth-transaction.store';
import { OAuthService } from './oauth.service';

const session = {
  accessToken: 'eduai-access-token',
  refreshToken: 'eduai-refresh-token',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
  user: {
    id: 'user-id',
    email: 'learner@example.com',
    fullName: 'Learner',
    status: UserStatus.active,
    roles: [RoleName.student],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

function createConfig(): AppConfigService {
  return {
    app: { nodeEnv: 'test' },
    oauth: {
      stateSecret: 's'.repeat(32),
      stateTtlSeconds: 300,
      ticketTtlSeconds: 120,
      facebook: { enabled: true },
      zalo: { enabled: true },
    },
  } as AppConfigService;
}

function createService(options: {
  state?: Record<string, unknown> | null;
  identity?: Record<string, unknown>;
  userByEmail?: Record<string, unknown> | null;
  externalIdentity?: Record<string, unknown> | null;
  ticket?: Record<string, unknown> | null;
} = {}) {
  const createdUser = {
    ...session.user,
    id: 'new-user-id',
    email: 'new@example.com',
    fullName: 'New User',
  };
  const pendingExternal = {
    id: 'external-id',
    provider: ExternalProvider.zalo,
    providerUserId: 'zalo-user-id',
    userId: null,
    providerEmail: null,
    providerName: 'Zalo Learner',
    providerAvatar: null,
    emailVerified: false,
    pendingExpiresAt: new Date(Date.now() + 120_000),
  };
  const tx = {
    externalIdentity: {
      findUnique: jest.fn().mockImplementation((input: { where?: { id?: string } }) =>
        input.where?.id
          ? options.externalIdentity ?? pendingExternal
          : options.externalIdentity ?? null,
      ),
      create: jest.fn().mockResolvedValue({ id: 'external-id' }),
      update: jest.fn().mockResolvedValue({ id: 'external-id' }),
    },
    role: {
      findUnique: jest.fn().mockResolvedValue({ id: 'role-id', name: RoleName.student }),
    },
    user: {
      findUnique: jest.fn().mockImplementation((input: { where?: { id?: string } }) =>
        input.where?.id ? createdUser : options.userByEmail ?? null,
      ),
      create: jest.fn().mockResolvedValue({ id: 'new-user-id' }),
    },
    userRole: { create: jest.fn().mockResolvedValue({ id: 'user-role-id' }) },
    refreshToken: { create: jest.fn().mockResolvedValue({ id: 'refresh-id' }) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const store = {
    setState: jest.fn(),
    consumeState: jest.fn().mockResolvedValue(options.state ?? null),
    setTicket: jest.fn(),
    consumeTicket: jest.fn().mockResolvedValue(options.ticket ?? null),
  };
  const provider = {
    getCapabilities: jest
      .fn()
      .mockReturnValue({ google: true, facebook: true, zalo: true }),
    buildAuthorizationUrl: jest.fn().mockReturnValue('https://provider.example/authorize'),
    resolveIdentity: jest.fn().mockResolvedValue(
      options.identity ?? {
        providerUserId: 'provider-user-id',
        email: 'new@example.com',
        emailVerified: false,
        fullName: 'New User',
      },
    ),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const authService = {
    issueSessionForUser: jest.fn().mockResolvedValue(session),
  };
  const service = new OAuthService(
    prisma as never,
    createConfig(),
    auditService as never,
    authService as never,
    store as unknown as OAuthTransactionStore,
    provider as unknown as OAuthProviderService,
  );

  return { service, tx, prisma, store, provider, auditService, authService };
}

describe('OAuthService', () => {
  it('stores an opaque, provider-bound state before starting authorization', async () => {
    const { service, store, provider } = createService();

    await expect(
      service.start('facebook', {
        mode: 'register',
        role: RoleName.instructor,
        redirectTo: '/instructor/dashboard',
      }),
    ).resolves.toEqual({ authorizationUrl: 'https://provider.example/authorize' });

    expect(store.setState).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({
        provider: 'facebook',
        mode: 'register',
        role: RoleName.instructor,
        redirectTo: '/instructor/dashboard',
      }),
      300,
    );
    expect(provider.buildAuthorizationUrl).toHaveBeenCalledWith(
      'facebook',
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
  });

  it('requires an explicit role before starting registration OAuth', async () => {
    const { service, store, provider } = createService();

    await expect(
      service.start('facebook', { mode: 'register', redirectTo: '/' }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_ROLE_REQUIRED' } });
    expect(store.setState).not.toHaveBeenCalled();
    expect(provider.buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('stores and forwards a server-held PKCE verifier for Zalo authorization', async () => {
    const { service, store, provider } = createService();

    await expect(
      service.start('zalo', { redirectTo: '/' }),
    ).resolves.toEqual({
      authorizationUrl: 'https://provider.example/authorize',
    });

    const [state, stateRecord] = store.setState.mock.calls[0];
    expect(stateRecord).toEqual(
      expect.objectContaining({
        provider: 'zalo',
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9._~-]{43}$/),
      }),
    );
    expect(provider.buildAuthorizationUrl).toHaveBeenCalledWith(
      'zalo',
      state,
      stateRecord.codeVerifier,
    );
  });

  it('rejects a callback when the consumed state belongs to another provider', async () => {
    const { service, provider } = createService({
      state: {
        provider: 'zalo',
        mode: 'login',
        redirectTo: '/',
        codeVerifier: 'v'.repeat(43),
        createdAt: Date.now(),
      },
    });

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_PROVIDER_MISMATCH' } });
    expect(provider.resolveIdentity).not.toHaveBeenCalled();
  });

  it('does not silently merge a social email into an existing EduAI account', async () => {
    const { service, tx, auditService } = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
      userByEmail: { id: 'local-user-id', status: UserStatus.active },
      identity: {
        providerUserId: 'facebook-user-id',
        email: 'existing@example.com',
        emailVerified: false,
        fullName: 'Existing Email',
      },
    });

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({
      response: { error: 'SOCIAL_ACCOUNT_LINK_REQUIRED' },
    });
    expect(tx.externalIdentity.create).not.toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SocialAccountLinkFailed,
        metadata: { provider: ExternalProvider.facebook, reason: 'email_collision' },
      }),
      tx,
    );
  });

  it('creates a pending identity and a one-time profile ticket when email is absent', async () => {
    const { service, tx, store } = createService({
      state: {
        provider: 'zalo',
        mode: 'login',
        redirectTo: '/',
        codeVerifier: 'v'.repeat(43),
        createdAt: Date.now(),
      },
      identity: {
        providerUserId: 'zalo-user-id',
        emailVerified: false,
        fullName: 'Zalo Learner',
      },
    });

    const result = await service.handleCallback('zalo', {
      state: 's'.repeat(43),
      code: 'provider-code',
    });

    expect(tx.externalIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: ExternalProvider.zalo,
        providerUserId: 'zalo-user-id',
        userId: null,
        providerEmail: null,
      }),
      select: { id: true },
    });
    expect(store.setTicket).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({
        kind: 'profile',
        mode: 'login',
        provider: 'zalo',
        externalIdentityId: 'external-id',
      }),
      120,
    );
    expect(result).toMatchObject({
      redirectUrl: expect.stringContaining('/auth/callback?provider=zalo&ticket='),
    });
  });

  it('exchanges a session ticket once and returns the normal EduAI session', async () => {
    const { service, authService, store } = createService({
      ticket: {
        kind: 'session',
        mode: 'login',
        provider: 'facebook',
        userId: 'user-id',
        redirectTo: '/',
        expiresAt: Date.now() + 120_000,
      },
    });

    await expect(service.exchange({ ticket: 't'.repeat(43) })).resolves.toEqual({
      kind: 'session',
      session,
      redirectTo: '/',
    });
    expect(authService.issueSessionForUser).toHaveBeenCalled();
    expect(store.consumeTicket).toHaveBeenCalledWith('t'.repeat(43));
  });

  it('rejects a profile completion ticket if the submitted email is already registered', async () => {
    const { service, tx } = createService({
      ticket: {
        kind: 'profile',
        mode: 'login',
        provider: 'zalo',
        externalIdentityId: 'external-id',
        role: RoleName.student,
        redirectTo: '/',
        expiresAt: Date.now() + 120_000,
      },
      userByEmail: { id: 'existing-user-id', status: UserStatus.active },
    });

    await expect(
      service.completeProfile({
        ticket: 't'.repeat(43),
        email: 'existing@example.com',
      }),
    ).rejects.toMatchObject({
      response: { error: 'SOCIAL_ACCOUNT_LINK_REQUIRED' },
    });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('does not silently assign a role to a register profile ticket', async () => {
    const { service, tx } = createService({
      ticket: {
        kind: 'profile',
        mode: 'register',
        provider: 'facebook',
        externalIdentityId: 'external-id',
        redirectTo: '/',
        expiresAt: Date.now() + 120_000,
      },
      externalIdentity: {
        id: 'external-id',
        provider: ExternalProvider.facebook,
        providerUserId: 'facebook-user-id',
        userId: null,
        providerEmail: null,
        providerName: 'Facebook User',
        providerAvatar: null,
        emailVerified: false,
        pendingExpiresAt: new Date(Date.now() + 120_000),
      },
    });

    await expect(
      service.completeProfile({
        ticket: 't'.repeat(43),
        email: 'new@example.com',
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_ROLE_REQUIRED' } });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.userRole.create).not.toHaveBeenCalled();
  });

  it('creates a first-time Facebook account with the requested non-privileged role', async () => {
    const { service, tx, store } = createService({
      state: {
        provider: 'facebook',
        mode: 'register',
        role: RoleName.instructor,
        redirectTo: '/instructor/dashboard',
        createdAt: Date.now(),
      },
      identity: {
        providerUserId: 'facebook-user-id',
        email: 'new.facebook@example.com',
        emailVerified: false,
        fullName: 'Facebook Instructor',
      },
    });

    await service.handleCallback('facebook', {
      state: 's'.repeat(43),
      code: 'facebook-code',
    });

    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authProvider: AuthProvider.facebook,
        email: 'new.facebook@example.com',
      }),
      select: { id: true },
    });
    expect(tx.role.findUnique).toHaveBeenCalledWith({
      where: { name: RoleName.instructor },
      select: { id: true },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { roleId: 'role-id', userId: 'new-user-id' },
    });
    expect(store.setTicket).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: 'session',
        mode: 'register',
        provider: 'facebook',
        redirectTo: '/instructor/dashboard',
        userId: 'new-user-id',
      }),
      120,
    );
  });

  it('returns a session ticket for a returning linked Facebook identity', async () => {
    const { service, tx, store } = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
      externalIdentity: {
        id: 'external-id',
        provider: ExternalProvider.facebook,
        providerUserId: 'facebook-user-id',
        userId: 'linked-user-id',
        providerEmail: 'linked@example.com',
        providerName: 'Linked User',
        providerAvatar: null,
        emailVerified: false,
        pendingExpiresAt: null,
      },
    });

    await service.handleCallback('facebook', {
      state: 's'.repeat(43),
      code: 'facebook-code',
    });

    expect(tx.user.create).not.toHaveBeenCalled();
    expect(store.setTicket).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: 'session',
        mode: 'login',
        userId: 'new-user-id',
      }),
      120,
    );
  });

  it('rejects a returning external identity when used from registration', async () => {
    const { service } = createService({
      state: {
        provider: 'zalo',
        mode: 'register',
        role: RoleName.student,
        redirectTo: '/',
        codeVerifier: 'v'.repeat(43),
        createdAt: Date.now(),
      },
      externalIdentity: {
        id: 'external-id',
        provider: ExternalProvider.zalo,
        providerUserId: 'zalo-user-id',
        userId: 'linked-user-id',
        providerEmail: null,
        providerName: 'Zalo User',
        providerAvatar: null,
        emailVerified: false,
        pendingExpiresAt: null,
      },
    });

    await expect(
      service.handleCallback('zalo', {
        state: 's'.repeat(43),
        code: 'zalo-code',
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_ALREADY_EXISTS' } });
  });

  it('rejects missing, expired, and replayed state before provider resolution', async () => {
    const missing = createService();
    await expect(
      missing.service.handleCallback('facebook', { code: 'code' }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_STATE_INVALID' } });
    expect(missing.provider.resolveIdentity).not.toHaveBeenCalled();

    const expired = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now() - 301_000,
      },
    });
    await expect(
      expired.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_STATE_INVALID' } });
    expect(expired.provider.resolveIdentity).not.toHaveBeenCalled();

    const replayState = {
      provider: 'facebook' as const,
      mode: 'login' as const,
      redirectTo: '/',
      createdAt: Date.now(),
    };
    const replayed = createService({ state: replayState });
    replayed.store.consumeState.mockReset();
    replayed.store.consumeState
      .mockResolvedValueOnce(replayState)
      .mockResolvedValueOnce(null);
    await expect(
      replayed.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).resolves.toBeDefined();
    await expect(
      replayed.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_STATE_INVALID' } });
  });

  it('maps provider code and profile failures to safe OAuth errors', async () => {
    const { service, provider } = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    provider.resolveIdentity.mockRejectedValueOnce(
      new OAuthProviderError(
        'facebook',
        'token_exchange',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      ),
    );

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'expired-code',
      }),
    ).rejects.toMatchObject({
      response: { error: 'OAUTH_PROVIDER_RESPONSE_INVALID' },
    });
  });

  it('keeps unexpected provider callback exceptions on the generic public error', async () => {
    const { service, provider } = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    provider.resolveIdentity.mockRejectedValueOnce(
      new Error('provider response contains secret detail'),
    );

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_CALLBACK_FAILED' } });
  });

  it('maps callback ticket-store outages to a safe service error', async () => {
    const context = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    context.store.setTicket.mockRejectedValueOnce(
      new OAuthStateStoreError(
        'OAUTH_STATE_STORE_UNAVAILABLE',
        'hidden store detail',
      ),
    );

    await expect(
      context.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({
      response: { error: 'OAUTH_STATE_STORE_UNAVAILABLE' },
    });
  });

  it('keeps unknown callback state-store exceptions on the generic public error', async () => {
    const context = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    context.store.consumeState.mockRejectedValueOnce(
      new Error('state store internal detail'),
    );

    await expect(
      context.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_CALLBACK_FAILED' } });
  });

  it('keeps unknown callback ticket-store exceptions on the generic public error', async () => {
    const context = createService({
      state: {
        provider: 'facebook',
        mode: 'login',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    context.store.setTicket.mockRejectedValueOnce(
      new Error('ticket store internal detail'),
    );

    await expect(
      context.service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'provider-code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_CALLBACK_FAILED' } });
  });

  it('rejects unsafe redirects and refuses provider start when disabled', async () => {
    const unsafe = createService();
    await expect(
      unsafe.service.start('facebook', { redirectTo: 'https://evil.example' }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_REDIRECT_NOT_ALLOWED' } });

    const disabled = createService();
    disabled.provider.getCapabilities.mockReturnValue({
      google: true,
      facebook: false,
      zalo: true,
    });
    await expect(
      disabled.service.start('facebook', {}),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_PROVIDER_UNAVAILABLE' } });
  });

  it('does not permit a login request to assign an instructor role', async () => {
    const { service } = createService();

    await expect(
      service.start('facebook', {
        mode: 'login',
        role: RoleName.instructor,
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_ROLE_NOT_ALLOWED' } });
  });

  it('rejects a tampered state role instead of escalating it', async () => {
    const { service, provider } = createService({
      state: {
        provider: 'facebook',
        mode: 'register',
        role: RoleName.platform_admin,
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_STATE_INVALID' } });
    expect(provider.resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects a register callback state without a role', async () => {
    const { service, provider } = createService({
      state: {
        provider: 'facebook',
        mode: 'register',
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).rejects.toMatchObject({ response: { error: 'OAUTH_STATE_INVALID' } });
    expect(provider.resolveIdentity).not.toHaveBeenCalled();
  });

  it('maps an email uniqueness race to the explicit-linking policy', async () => {
    const { service, tx, auditService } = createService({
      state: {
        provider: 'facebook',
        mode: 'register',
        role: RoleName.student,
        redirectTo: '/',
        createdAt: Date.now(),
      },
    });
    tx.user.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['email'] },
    });

    await expect(
      service.handleCallback('facebook', {
        state: 's'.repeat(43),
        code: 'code',
      }),
    ).rejects.toMatchObject({ response: { error: 'SOCIAL_ACCOUNT_LINK_REQUIRED' } });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.SocialAccountLinkFailed }),
      undefined,
    );
  });

  it('cannot exchange the same session ticket twice', async () => {
    const context = createService({
      ticket: {
        kind: 'session',
        mode: 'login',
        provider: 'facebook',
        userId: 'user-id',
        redirectTo: '/',
        expiresAt: Date.now() + 120_000,
      },
    });
    const sessionTicket = {
      kind: 'session' as const,
      mode: 'login' as const,
      provider: 'facebook' as const,
      userId: 'user-id',
      redirectTo: '/',
      expiresAt: Date.now() + 120_000,
    };
    context.store.consumeTicket.mockReset();
    context.store.consumeTicket
      .mockResolvedValueOnce(sessionTicket)
      .mockResolvedValueOnce(null);

    await expect(context.service.exchange({ ticket: 't'.repeat(43) })).resolves.toBeDefined();
    await expect(context.service.exchange({ ticket: 't'.repeat(43) })).rejects.toMatchObject({
      response: { error: 'OAUTH_TICKET_INVALID' },
    });
  });
});
