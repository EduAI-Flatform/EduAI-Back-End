import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AuthProvider,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

function createAuditService() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

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
    hashPassword: jest.fn().mockImplementation(async (value: string) =>
      value === 'Str0ngPassword!123' ? 'password-hash' : 'refresh-hash',
    ),
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
  const auditService = createAuditService();
  const service = new AuthService(
    prisma as never,
    passwordService,
    jwtService,
    appConfig,
    auditService as never,
    firebaseAdmin,
  );

  return {
    auditService,
    service,
    prisma,
    tx,
    firebaseAdmin,
    passwordService,
  };
}

describe('AuthService.loginWithFirebase', () => {
  it('requires a role before creating a new Firebase user', async () => {
    const { service, tx } = createService();

    await expect(
      service.loginWithFirebase({ idToken: 'firebase-id-token' }),
    ).rejects.toMatchObject({
      response: {
        error: 'ACCOUNT_ROLE_REQUIRED',
      },
      status: 409,
    });

    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.userRole.create).not.toHaveBeenCalled();
  });

  it('creates a Firebase user with the selected role', async () => {
    const { auditService, service, tx, firebaseAdmin } = createService();

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        role: RoleName.student,
      }),
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
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: baseUser.id,
        action: AuditAction.AuthLogin,
        target: { type: 'user', id: baseUser.id },
        metadata: { provider: AuthProvider.google },
      },
      tx,
    );
    expect(JSON.stringify(tx.user.create.mock.calls)).not.toContain(
      'firebase-id-token',
    );
  });

  it('completes verified Firebase password registration with a local password hash', async () => {
    const claims = {
      ...firebaseClaims,
      firebase: { sign_in_provider: 'password' },
    };
    const { passwordService, service, tx } = createService({
      firebaseClaims: claims,
      role: { id: 'instructor-role-id', name: RoleName.instructor },
    });

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        mode: 'register',
        password: 'Str0ngPassword!123',
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
          passwordHash: 'password-hash',
        }),
      }),
    );
    expect(passwordService.hashPassword).toHaveBeenCalledWith(
      'Str0ngPassword!123',
    );
    expect(JSON.stringify(tx.user.create.mock.calls)).not.toContain(
      'Str0ngPassword!123',
    );
    expect(tx.role.findUnique).toHaveBeenCalledWith({
      where: { name: RoleName.instructor },
      select: { id: true, name: true },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { roleId: 'instructor-role-id', userId: 'user-id' },
    });
  });

  it('rejects Firebase password authentication outside registration completion', async () => {
    const { service, prisma } = createService({
      firebaseClaims: {
        ...firebaseClaims,
        firebase: { sign_in_provider: 'password' },
      },
    });

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        password: 'Str0ngPassword!123',
      }),
    ).rejects.toMatchObject({
      response: { error: 'INVALID_FIREBASE_TOKEN' },
      status: 401,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires a password to complete Firebase password registration', async () => {
    const { service, prisma } = createService({
      firebaseClaims: {
        ...firebaseClaims,
        firebase: { sign_in_provider: 'password' },
      },
    });

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        mode: 'register',
        role: RoleName.student,
      }),
    ).rejects.toMatchObject({
      response: { error: 'INVALID_REGISTRATION_PASSWORD' },
      status: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  it('rejects Google registration when the Firebase account already exists', async () => {
    const existingUser = { ...baseUser };
    const { service, tx } = createService({ users: [null, existingUser] });

    await expect(
      service.loginWithFirebase({
        idToken: 'firebase-id-token',
        mode: 'register',
        role: RoleName.instructor,
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'ACCOUNT_ALREADY_EXISTS',
        message: 'Tài khoản này đã tồn tại. Vui lòng đăng nhập.',
      },
      status: 409,
    });

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
      createAuditService() as never,
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
