import { ConflictException } from '@nestjs/common';
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
    } as unknown as PasswordService;
    const service = new AuthService(prisma as never, passwordService);

    return { service, prisma, tx, passwordService };
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
