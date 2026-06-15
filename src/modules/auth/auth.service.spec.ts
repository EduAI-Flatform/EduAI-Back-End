import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

describe('AuthService.register', () => {
  const registerInput = {
    email: 'STUDENT@Example.com',
    password: 'Str0ngPassword!123',
    fullName: 'Student User',
  };

  const role = {
    id: 'role-id',
    name: 'student',
  };

  const createdUser = {
    id: 'user-id',
    email: 'student@example.com',
    fullName: 'Student User',
    status: 'active',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
  };

  function createService(options?: { existingUser?: unknown }) {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(options?.existingUser ?? null),
        create: jest.fn().mockResolvedValue(createdUser),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue(role),
      },
      userRole: {
        create: jest.fn().mockResolvedValue({ id: 'user-role-id' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const passwordService = {
      hashPassword: jest.fn().mockResolvedValue('hashed-password'),
      comparePassword: jest.fn().mockResolvedValue(true),
    } as unknown as PasswordService;
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
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
    );

    return { service, prisma, tx, passwordService, jwtService };
  }

  it('rejects duplicate email addresses', async () => {
    const { service } = createService({ existingUser: { id: 'existing-id' } });

    await expect(service.register(registerInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('hashes the password before creating the user', async () => {
    const { service, tx, passwordService } = createService();

    await service.register(registerInput);

    expect(passwordService.hashPassword).toHaveBeenCalledWith(
      registerInput.password,
    );
    expect(tx.user.create).toHaveBeenCalledWith({
      data: {
        email: 'student@example.com',
        fullName: 'Student User',
        passwordHash: 'hashed-password',
      },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        status: true,
        updatedAt: true,
      },
    });
  });

  it('assigns the default student role and returns a sanitized user', async () => {
    const { service, tx } = createService();

    await expect(service.register(registerInput)).resolves.toEqual({
      user: {
        ...createdUser,
        roles: ['student'],
      },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: {
        roleId: role.id,
        userId: createdUser.id,
      },
    });
  });
});

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
  }) {
    const selectedUser =
      options && 'user' in options ? options.user : user;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(selectedUser),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-token-id' }),
      },
    };
    const passwordService = {
      comparePassword: jest
        .fn()
        .mockResolvedValue(options?.passwordMatches ?? true),
      hashPassword: jest
        .fn()
        .mockResolvedValueOnce('hashed-refresh-token'),
    } as unknown as PasswordService;
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
    const service = new AuthService(
      prisma as never,
      passwordService,
      jwtService,
      appConfig,
    );

    return { service, prisma, passwordService, jwtService };
  }

  it('rejects missing users as invalid credentials', async () => {
    const { service } = createService({ user: null });

    await expect(service.login(loginInput)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects password mismatches as invalid credentials', async () => {
    const { service } = createService({ passwordMatches: false });

    await expect(service.login(loginInput)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('issues tokens and stores only a hashed refresh token', async () => {
    const { service, prisma, passwordService, jwtService } = createService();

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
