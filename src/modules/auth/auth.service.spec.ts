import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RoleName } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

function createAuditService() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

describe('AuthService.login', () => {
  const loginInput = {
    email: 'STUDENT@Example.com',
    password: 'Str0ngPassword!123',
  };
  const user = {
    id: 'user-id',
    email: 'student@example.com',
    fullName: 'Student User',
    passwordHash: 'hashed-password',
    status: 'active',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    roles: [
      {
        role: {
          name: 'student',
        },
      },
    ],
  };

  function createService(options?: {
    user?: typeof user | null;
    passwordMatches?: boolean;
    passwordService?: PasswordService;
  }) {
    const selectedUser =
      options && 'user' in options ? options.user : user;
    let prisma: Record<string, any>;
    prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
        callback(prisma),
      ),
      user: {
        findUnique: jest.fn().mockResolvedValue(selectedUser),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-token-id' }),
      },
    };
    const passwordService =
      options?.passwordService ??
      ({
        comparePassword: jest
          .fn()
          .mockResolvedValue(options?.passwordMatches ?? true),
        hashPassword: jest
          .fn()
          .mockResolvedValueOnce('hashed-refresh-token'),
      } as unknown as PasswordService);
    const jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token'),
    } as unknown as JwtService;
    const appConfig = {
      jwt: {
        accessSecret: 'access-secret',
        refreshSecret: 'refresh-secret',
      },
    } as AppConfigService;
    const auditService = createAuditService();
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
      auditService as never,
    );

    return { auditService, service, prisma, passwordService, jwtService };
  }

  it('returns ACCOUNT_NOT_FOUND when the normalized email does not exist', async () => {
    const { service } = createService({ user: null });

    await expect(service.login(loginInput)).rejects.toMatchObject({
      response: {
        error: 'ACCOUNT_NOT_FOUND',
        message: 'Tài khoản chưa tồn tại. Vui lòng đăng ký.',
      },
      status: 401,
    });
  });

  it('returns INVALID_CREDENTIALS when the password does not match', async () => {
    const { service } = createService({ passwordMatches: false });

    await expect(service.login(loginInput)).rejects.toMatchObject({
      response: {
        error: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không đúng.',
      },
      status: 401,
    });
  });

  it('returns ACCOUNT_BLOCKED before comparing a non-active account password', async () => {
    const blockedUser = { ...user, status: 'suspended' as const };
    const { passwordService, service } = createService({ user: blockedUser });

    await expect(service.login(loginInput)).rejects.toMatchObject({
      response: {
        error: 'ACCOUNT_BLOCKED',
        message: 'Tài khoản đã bị khóa.',
      },
      status: 403,
    });
    expect(passwordService.comparePassword).not.toHaveBeenCalled();
  });

  it('safely rejects a local account without a password hash', async () => {
    const { passwordService, service } = createService({
      user: { ...user, passwordHash: null } as never,
    });

    await expect(service.login(loginInput)).rejects.toMatchObject({
      response: {
        error: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không đúng.',
      },
      status: 401,
    });
    expect(passwordService.comparePassword).not.toHaveBeenCalled();
  });

  it('authenticates the seeded administrator through the real password service', async () => {
    const passwordService = new PasswordService();
    const seededPassword = 'SeededAdminPassword!123';
    const seededAdmin = {
      ...user,
      email: 'admin.demo@eduai.local',
      fullName: 'EduAI Admin',
      passwordHash: await passwordService.hashPassword(seededPassword),
      roles: [{ role: { name: RoleName.platform_admin } }],
    };
    const { service } = createService({
      passwordService,
      user: seededAdmin,
    });

    await expect(
      service.login({ email: seededAdmin.email, password: seededPassword }),
    ).resolves.toMatchObject({
      user: {
        email: seededAdmin.email,
        roles: [RoleName.platform_admin],
      },
    });
  });

  it('rejects a wrong password for the seeded administrator', async () => {
    const passwordService = new PasswordService();
    const seededAdmin = {
      ...user,
      email: 'admin.demo@eduai.local',
      fullName: 'EduAI Admin',
      passwordHash: await passwordService.hashPassword(
        'SeededAdminPassword!123',
      ),
      roles: [{ role: { name: RoleName.platform_admin } }],
    };
    const { service } = createService({
      passwordService,
      user: seededAdmin,
    });

    await expect(
      service.login({
        email: seededAdmin.email,
        password: 'WrongSeededPassword!123',
      }),
    ).rejects.toMatchObject({
      response: { error: 'INVALID_CREDENTIALS' },
      status: 401,
    });
  });

  it('issues tokens and stores only a hashed refresh token', async () => {
    const { auditService, service, prisma, passwordService, jwtService } =
      createService();

    const result = await service.login(loginInput);

    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roles: ['student'],
      },
    });
    expect(passwordService.comparePassword).toHaveBeenCalledWith(
      loginInput.password,
      user.passwordHash,
    );
    expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
    expect(passwordService.hashPassword).toHaveBeenCalledWith('refresh-token');
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: {
        expiresAt: expect.any(Date),
        tokenHash: 'hashed-refresh-token',
        userId: user.id,
      },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: user.id,
        action: AuditAction.AuthLogin,
        target: { type: 'user', id: user.id },
        metadata: { provider: 'local' },
      },
      prisma,
    );
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });
});

describe('AuthService.refresh', () => {
  const refreshInput = {
    refreshToken: 'old-refresh-token',
  };
  const user = {
    id: 'user-id',
    email: 'student@example.com',
    fullName: 'Student User',
    status: 'active',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    roles: [
      {
        role: {
          name: 'student',
        },
      },
    ],
    refreshTokens: [
      {
        id: 'refresh-token-id',
        tokenHash: 'stored-refresh-token-hash',
      },
    ],
  };

  function createService(options?: {
    user?: typeof user | null;
    tokenMatches?: boolean;
    verifyFails?: boolean;
  }) {
    const selectedUser =
      options && 'user' in options ? options.user : user;
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(selectedUser),
      },
      refreshToken: {
        update: jest.fn().mockResolvedValue({ id: 'refresh-token-id' }),
        create: jest.fn().mockResolvedValue({ id: 'new-refresh-token-id' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const passwordService = {
      comparePassword: jest
        .fn()
        .mockResolvedValue(options?.tokenMatches ?? true),
      hashPassword: jest.fn().mockResolvedValue('new-refresh-token-hash'),
    } as unknown as PasswordService;
    const jwtService = {
      verifyAsync: jest.fn(
        options?.verifyFails
          ? async () => {
              throw new Error('invalid token');
            }
          : async () => ({
              sub: user.id,
              email: user.email,
              roles: ['student'],
            }),
      ),
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token'),
    } as unknown as JwtService;
    const appConfig = {
      jwt: {
        accessSecret: 'access-secret',
        refreshSecret: 'refresh-secret',
      },
    } as AppConfigService;
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
      createAuditService() as never,
    );

    return { service, tx, passwordService, jwtService };
  }

  it('rejects invalid refresh tokens', async () => {
    const { service } = createService({ verifyFails: true });

    await expect(service.refresh(refreshInput)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects expired or revoked refresh tokens', async () => {
    const { service } = createService({ tokenMatches: false });

    await expect(service.refresh(refreshInput)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rotates refresh tokens and revokes the previous token', async () => {
    const { service, tx, passwordService, jwtService } = createService();

    await expect(service.refresh(refreshInput)).resolves.toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        id: user.id,
        email: user.email,
        roles: ['student'],
      },
    });
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('old-refresh-token', {
      secret: 'refresh-secret',
    });
    expect(passwordService.comparePassword).toHaveBeenCalledWith(
      'old-refresh-token',
      'stored-refresh-token-hash',
    );
    expect(tx.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'refresh-token-id' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(passwordService.hashPassword).toHaveBeenCalledWith(
      'new-refresh-token',
    );
    expect(tx.refreshToken.create).toHaveBeenCalledWith({
      data: {
        expiresAt: expect.any(Date),
        tokenHash: 'new-refresh-token-hash',
        userId: user.id,
      },
    });
  });
});

describe('AuthService.logout', () => {
  const logoutInput = {
    refreshToken: 'refresh-token',
  };
  const user = {
    id: 'user-id',
    refreshTokens: [
      {
        id: 'refresh-token-id',
        tokenHash: 'stored-refresh-token-hash',
      },
    ],
  };

  function createService(options?: {
    tokenMatches?: boolean;
    verifyFails?: boolean;
  }) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
      },
      refreshToken: {
        update: jest.fn().mockResolvedValue({ id: 'refresh-token-id' }),
      },
    };
    const passwordService = {
      comparePassword: jest
        .fn()
        .mockResolvedValue(options?.tokenMatches ?? true),
      hashPassword: jest.fn(),
    } as unknown as PasswordService;
    const jwtService = {
      verifyAsync: jest.fn(
        options?.verifyFails
          ? async () => {
              throw new Error('invalid token');
            }
          : async () => ({
              sub: user.id,
            }),
      ),
      signAsync: jest.fn(),
    } as unknown as JwtService;
    const appConfig = {
      jwt: {
        accessSecret: 'access-secret',
        refreshSecret: 'refresh-secret',
      },
    } as AppConfigService;
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
      createAuditService() as never,
    );

    return { service, prisma };
  }

  it('rejects invalid refresh tokens', async () => {
    const { service } = createService({ verifyFails: true });

    await expect(service.logout(logoutInput)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('invalidates the matching refresh token', async () => {
    const { service, prisma } = createService();

    await expect(service.logout(logoutInput)).resolves.toEqual({
      loggedOut: true,
    });
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'refresh-token-id' },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('AuthService.getCurrentUser', () => {
  const user = {
    id: 'user-id',
    email: 'student@example.com',
    fullName: 'Student User',
    status: 'active',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    roles: [
      {
        role: {
          name: 'student',
        },
      },
    ],
  };

  function createService(options?: { user?: typeof user | null }) {
    const selectedUser = options && 'user' in options ? options.user : user;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(selectedUser),
      },
    };
    const passwordService = {
      comparePassword: jest.fn(),
      hashPassword: jest.fn(),
    } as unknown as PasswordService;
    const jwtService = {
      signAsync: jest.fn(),
      verifyAsync: jest.fn(),
    } as unknown as JwtService;
    const appConfig = {
      jwt: {
        accessSecret: 'access-secret',
        refreshSecret: 'refresh-secret',
      },
    } as AppConfigService;
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
      createAuditService() as never,
    );

    return { service, prisma };
  }

  it('returns a safe current user profile', async () => {
    const { service, prisma } = createService();

    await expect(service.getCurrentUser(user.id)).resolves.toEqual({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      roles: ['student'],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: user.id },
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
  });

  it('does not return sensitive fields', async () => {
    const { service } = createService();

    const result = await service.getCurrentUser(user.id);

    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('refreshToken');
  });

  it('rejects missing users as invalid access tokens', async () => {
    const { service } = createService({ user: null });

    await expect(service.getCurrentUser(user.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects inactive users as invalid access tokens', async () => {
    const { service } = createService({
      user: {
        ...user,
        status: 'inactive',
      },
    });

    await expect(service.getCurrentUser(user.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
