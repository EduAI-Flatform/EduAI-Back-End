import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AuthProvider,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

const firebaseClaims = {
  email: 'student@example.com',
  email_verified: true,
  firebase: { sign_in_provider: 'google.com' },
  name: 'Student User',
  picture: 'https://example.com/student.png',
  uid: 'firebase-uid',
};

const baseUser = {
  avatarUrl: null,
  createdAt: new Date('2026-06-13T00:00:00.000Z'),
  email: 'student@example.com',
  firebaseUid: null,
  fullName: 'Student User',
  id: 'user-id',
  roles: [{ role: { name: RoleName.student } }],
  status: UserStatus.active,
  updatedAt: new Date('2026-06-13T00:00:00.000Z'),
};

function createService(options?: {
  firebaseClaims?: unknown;
  role?: { id: string; name: RoleName };
  users?: unknown[];
}) {
  const role = options?.role ?? {
    id: 'student-role-id',
    name: RoleName.student,
  };
  const tx = {
    role: {
      findUnique: jest.fn().mockResolvedValue(role),
    },
    refreshToken: {
      create: jest.fn().mockResolvedValue({ id: 'refresh-token-id' }),
    },
    user: {
      create: jest.fn().mockResolvedValue({
        ...baseUser,
        avatarUrl: firebaseClaims.picture,
        authProvider: AuthProvider.google,
        emailVerified: true,
        firebaseUid: firebaseClaims.uid,
      }),
      findUnique: jest.fn(),
      update: jest.fn().mockImplementation(async ({ data, select }) => ({
        ...baseUser,
        ...data,
      })),
    },
    userRole: {
      create: jest.fn().mockResolvedValue({ id: 'user-role-id' }),
    },
  };
  const users = options?.users ?? [null, null];
  tx.user.findUnique
    .mockResolvedValueOnce(users[0] ?? null)
    .mockResolvedValueOnce(users[1] ?? null);

  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const passwordService = {
    hashPassword: jest.fn().mockResolvedValue('refresh-hash'),
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
  const firebaseAdmin = {
    verifyIdToken: jest
      .fn()
      .mockResolvedValue(options?.firebaseClaims ?? firebaseClaims),
  };
  const service = new AuthService(
    prisma as never,
    passwordService,
    jwtService,
    appConfig,
    firebaseAdmin,
  );

  return { service, prisma, tx, firebaseAdmin };
}

describe('AuthService.loginWithFirebase', () => {
  it('creates a student user and issues the existing JWT response', async () => {
    const { service, tx, firebaseAdmin } = createService();

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        id: 'user-id',
        email: 'student@example.com',
        roles: [RoleName.student],
      },
    });

    expect(firebaseAdmin.verifyIdToken).toHaveBeenCalledWith('firebase-id-token');
    expect(tx.user.findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { firebaseUid: 'firebase-uid' } }),
    );
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          authProvider: AuthProvider.google,
          avatarUrl: 'https://example.com/student.png',
          email: 'student@example.com',
          emailVerified: true,
          firebaseUid: 'firebase-uid',
          fullName: 'Student User',
          passwordHash: null,
        },
      }),
    );
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { roleId: 'student-role-id', userId: 'user-id' },
    });
    expect(tx.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: 'refresh-hash',
        userId: 'user-id',
      }),
    });
    expect(JSON.stringify(tx.user.create.mock.calls)).not.toContain(
      'firebase-id-token',
    );
  });

  it('accepts a verified Firebase password user and preserves the requested role', async () => {
    const claims = {
      ...firebaseClaims,
      firebase: { sign_in_provider: 'password' },
    };
    const { service, tx } = createService({
      firebaseClaims: claims,
      role: { id: 'instructor-role-id', name: RoleName.instructor },
    });

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        role: RoleName.instructor,
      }),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      user: { roles: [RoleName.instructor] },
    });

    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authProvider: AuthProvider.local,
          emailVerified: true,
          firebaseUid: 'firebase-uid',
          passwordHash: null,
        }),
      }),
    );
    expect(tx.role.findUnique).toHaveBeenCalledWith({
      where: { name: RoleName.instructor },
      select: { id: true, name: true },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { roleId: 'instructor-role-id', userId: 'user-id' },
    });
  });

  it('links an existing email user without overwriting custom profile fields', async () => {
    const existingUser = {
      ...baseUser,
      avatarUrl: 'https://cdn.example.com/custom.png',
      fullName: 'Custom Name',
    };
    const { service, tx } = createService({ users: [null, existingUser] });

    await service.loginWithFirebase({ idToken: 'firebase-id-token' });

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-id' },
        data: {
          authProvider: AuthProvider.google,
          emailVerified: true,
          firebaseUid: 'firebase-uid',
        },
      }),
    );
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('finds the Firebase UID first and rejects ambiguous account matches', async () => {
    const { service, tx } = createService({
      users: [
        { ...baseUser, id: 'firebase-user-id', firebaseUid: 'firebase-uid' },
        { ...baseUser, id: 'email-user-id' },
      ],
    });

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('rejects an email already linked to another Firebase UID', async () => {
    const { service, tx } = createService({
      users: [null, { ...baseUser, firebaseUid: 'another-firebase-uid' }],
    });

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported provider', {
      ...firebaseClaims,
      firebase: { sign_in_provider: 'facebook.com' },
    }],
    ['missing email', { ...firebaseClaims, email: undefined }],
  ])('rejects %s', async (_label, claims) => {
    const { service, prisma } = createService({ firebaseClaims: claims });

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an unverified Firebase password user with the public error contract', async () => {
    const { service, prisma } = createService({
      firebaseClaims: {
        ...firebaseClaims,
        email_verified: false,
        firebase: { sign_in_provider: 'password' },
      },
    });

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toMatchObject({
      response: {
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Email chưa được xác minh. Vui lòng kiểm tra hộp thư.',
      },
      status: 403,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects blocked Firebase users without issuing a session', async () => {
    const { service, prisma } = createService({
      users: [{ ...baseUser, status: UserStatus.suspended }, null],
    });

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toMatchObject({
      response: {
        error: 'ACCOUNT_BLOCKED',
        message: 'Tài khoản đã bị khóa.',
      },
      status: 403,
    });

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('maps Firebase verification failures to unauthorized errors', async () => {
    const { service, firebaseAdmin } = createService();
    firebaseAdmin.verifyIdToken.mockRejectedValueOnce(new Error('invalid token'));

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not allow a Google-only user to authenticate with a password', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...baseUser,
          passwordHash: null,
        }),
      },
    };
    const passwordService = {
      comparePassword: jest.fn(),
    } as unknown as PasswordService;
    const jwtService = {} as JwtService;
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

    await expect(
      service.login({
        email: 'student@example.com',
        password: 'Str0ngPassword!123',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwordService.comparePassword).not.toHaveBeenCalled();
  });
});
