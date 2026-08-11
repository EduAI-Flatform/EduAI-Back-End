import { NotFoundException } from '@nestjs/common';
import {
  AuthProvider,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AdminUserService } from './admin-user.service';

const createdAt = new Date('2026-08-01T00:00:00.000Z');
const updatedAt = new Date('2026-08-02T00:00:00.000Z');
const databaseUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'learner@example.com',
  fullName: 'Learner Example',
  status: UserStatus.active,
  authProvider: AuthProvider.local,
  emailVerified: true,
  createdAt,
  updatedAt,
  roles: [
    { role: { name: RoleName.student } },
    { role: { name: RoleName.instructor } },
  ],
};

describe('AdminUserService read operations', () => {
  it('returns sanitized users with bounded filters and pagination', async () => {
    const prisma = {
      user: {
        count: jest.fn().mockReturnValue('count-query'),
        findMany: jest.fn().mockReturnValue('users-query'),
      },
      $transaction: jest.fn().mockResolvedValue([1, [databaseUser]]),
    };
    const service = new AdminUserService(prisma as never, {} as never);

    await expect(
      service.listUsers({
        page: 2,
        pageSize: 10,
        search: 'learner',
        role: RoleName.student,
        status: UserStatus.active,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: databaseUser.id,
          email: databaseUser.email,
          fullName: databaseUser.fullName,
          status: databaseUser.status,
          authProvider: databaseUser.authProvider,
          emailVerified: databaseUser.emailVerified,
          createdAt,
          updatedAt,
          roles: [RoleName.instructor, RoleName.student],
        },
      ],
      page: 2,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });

    const where = {
      deletedAt: null,
      status: UserStatus.active,
      roles: { some: { role: { name: RoleName.student } } },
      OR: [
        { email: { contains: 'learner', mode: 'insensitive' } },
        { fullName: { contains: 'learner', mode: 'insensitive' } },
      ],
    };
    expect(prisma.user.count).toHaveBeenCalledWith({ where });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 10,
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith([
      'count-query',
      'users-query',
    ]);
    expect(JSON.stringify(await service.listUsers({ page: 1, pageSize: 25 })))
      .not.toMatch(/passwordHash|refreshToken|firebaseUid|deletedAt/);
  });

  it('returns a sanitized user detail', async () => {
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(databaseUser) },
    };
    const service = new AdminUserService(prisma as never, {} as never);

    await expect(service.getUser(databaseUser.id)).resolves.toEqual(
      expect.objectContaining({
        id: databaseUser.id,
        roles: [RoleName.instructor, RoleName.student],
      }),
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: databaseUser.id, deletedAt: null },
      }),
    );
  });

  it('does not disclose whether a deleted or unknown user exists', async () => {
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new AdminUserService(prisma as never, {} as never);

    await expect(service.getUser('missing-user')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
