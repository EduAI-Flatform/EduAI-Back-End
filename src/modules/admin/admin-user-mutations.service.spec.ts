import { ConflictException } from '@nestjs/common';
import {
  AuthProvider,
  Prisma,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AdminUserService } from './admin-user.service';

interface TestUserRecord {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  authProvider: AuthProvider;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: Array<{ role: { name: RoleName } }>;
}

const baseUser: TestUserRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@example.com',
  fullName: 'Admin Example',
  status: UserStatus.active,
  authProvider: AuthProvider.local,
  emailVerified: true,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-02T00:00:00.000Z'),
  roles: [{ role: { name: RoleName.platform_admin } }],
};

function createMutationService(options?: {
  user?: TestUserRecord;
  otherActiveAdmins?: number;
  updatedUser?: TestUserRecord;
}) {
  const user = options?.user ?? baseUser;
  const updatedUser = options?.updatedUser ?? user;
  const tx = {
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValue(updatedUser),
      count: jest.fn().mockResolvedValue(options?.otherActiveAdmins ?? 1),
      update: jest.fn().mockResolvedValue(updatedUser),
    },
    role: {
      findMany: jest.fn().mockImplementation(async ({ where }) =>
        where.name.in.map((name: RoleName, index: number) => ({
          id: `role-${index}`,
          name,
        })),
      ),
    },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({ count: user.roles.length }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refreshToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new AdminUserService(prisma as never, auditService as never),
    prisma,
    tx,
    auditService,
  };
}

describe('AdminUserService status mutations', () => {
  it('rejects suspending the last active platform administrator', async () => {
    const { service, tx, auditService } = createMutationService({
      otherActiveAdmins: 0,
    });

    await expect(
      service.setStatus(
        'actor-id',
        baseUser.id,
        UserStatus.suspended,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('suspends a user, revokes refresh sessions, and audits atomically', async () => {
    const student = {
      ...baseUser,
      status: UserStatus.active,
      roles: [{ role: { name: RoleName.student } }],
    };
    const suspended = { ...student, status: UserStatus.suspended };
    const { service, prisma, tx, auditService } = createMutationService({
      user: student,
      updatedUser: suspended,
    });

    await expect(
      service.setStatus('actor-id', student.id, UserStatus.suspended),
    ).resolves.toEqual(expect.objectContaining({ status: UserStatus.suspended }));
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: student.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: 'actor-id',
        action: AuditAction.UserStatusChanged,
        target: { type: 'user', id: student.id },
        metadata: {
          previousStatus: UserStatus.active,
          newStatus: UserStatus.suspended,
        },
      },
      tx,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('retries a serializable write conflict before applying the safeguard', async () => {
    const student = {
      ...baseUser,
      roles: [{ role: { name: RoleName.student } }],
    };
    const suspended = { ...student, status: UserStatus.suspended };
    const { service, prisma } = createMutationService({
      user: student,
      updatedUser: suspended,
    });
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.setStatus('actor-id', student.id, UserStatus.suspended),
    ).resolves.toEqual(expect.objectContaining({ status: UserStatus.suspended }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe('AdminUserService role mutations', () => {
  it('rejects removing the last active platform administrator role', async () => {
    const { service, tx, auditService } = createMutationService({
      otherActiveAdmins: 0,
    });

    await expect(
      service.setRoles('actor-id', baseUser.id, [RoleName.instructor]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.userRole.deleteMany).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('sets supported roles, revokes refresh sessions, and audits atomically', async () => {
    const student = {
      ...baseUser,
      roles: [{ role: { name: RoleName.student } }],
    };
    const updated = {
      ...student,
      roles: [
        { role: { name: RoleName.instructor } },
        { role: { name: RoleName.student } },
      ],
    };
    const { service, tx, auditService } = createMutationService({
      user: student,
      updatedUser: updated,
    });

    await expect(
      service.setRoles('actor-id', student.id, [
        RoleName.student,
        RoleName.instructor,
      ]),
    ).resolves.toEqual({
      ...updated,
      roles: [RoleName.instructor, RoleName.student],
    });
    expect(tx.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: student.id },
    });
    expect(tx.userRole.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { userId: student.id, roleId: 'role-0' },
        { userId: student.id, roleId: 'role-1' },
      ]),
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: student.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: 'actor-id',
        action: AuditAction.UserRoleChanged,
        target: { type: 'user', id: student.id },
        metadata: {
          previousRoles: [RoleName.student],
          newRoles: [RoleName.instructor, RoleName.student],
        },
      },
      tx,
    );
  });
});
