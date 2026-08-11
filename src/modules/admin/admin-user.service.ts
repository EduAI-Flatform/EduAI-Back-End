import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuthProvider,
  Prisma,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';

const adminUserSelect = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  authProvider: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { name: true } } } },
} satisfies Prisma.UserSelect;

type AdminUserRecord = Prisma.UserGetPayload<{
  select: typeof adminUserSelect;
}>;

export interface AdminUserResponse {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  authProvider: AuthProvider;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: RoleName[];
}

export interface ListAdminUsersQuery {
  page: number;
  pageSize: number;
  search?: string;
  role?: RoleName;
  status?: UserStatus;
}

export interface PaginatedAdminUserResponse {
  items: AdminUserResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listUsers(
    query: ListAdminUsersQuery,
  ): Promise<PaginatedAdminUserResponse> {
    const where = this.buildWhere(query);
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: adminUserSelect,
      }),
    ]);

    return {
      items: users.map((user) => this.toResponse(user)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async getUser(userId: string): Promise<AdminUserResponse> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: adminUserSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toResponse(user);
  }

  setStatus(
    actorId: string,
    userId: string,
    status: Extract<UserStatus, 'active' | 'suspended'>,
  ): Promise<AdminUserResponse> {
    return this.runSerializable(async (tx) => {
      const user = await this.findMutationTarget(tx, userId);
      if (user.status === status) return this.toResponse(user);

      const currentRoles = this.roleNames(user);
      if (
        currentRoles.includes(RoleName.platform_admin) &&
        status !== UserStatus.active
      ) {
        await this.assertAnotherActiveAdmin(tx, userId);
      }

      const now = new Date();
      const updated = await tx.user.update({
        where: { id: userId },
        data: { status },
        select: adminUserSelect,
      });

      if (status !== UserStatus.active) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      await this.auditService.record(
        {
          actorId,
          action: AuditAction.UserStatusChanged,
          target: { type: 'user', id: userId },
          metadata: {
            previousStatus: user.status,
            newStatus: status,
          },
        },
        tx,
      );

      return this.toResponse(updated);
    });
  }

  setRoles(
    actorId: string,
    userId: string,
    roles: RoleName[],
  ): Promise<AdminUserResponse> {
    const desiredRoles = [...new Set(roles)].sort();
    if (desiredRoles.length === 0) {
      throw new BadRequestException('At least one role is required');
    }

    return this.runSerializable(async (tx) => {
      const user = await this.findMutationTarget(tx, userId);
      const currentRoles = this.roleNames(user);
      if (this.sameRoles(currentRoles, desiredRoles)) {
        return this.toResponse(user);
      }

      if (
        currentRoles.includes(RoleName.platform_admin) &&
        !desiredRoles.includes(RoleName.platform_admin)
      ) {
        await this.assertAnotherActiveAdmin(tx, userId);
      }

      const roleRecords = await tx.role.findMany({
        where: { name: { in: desiredRoles } },
        select: { id: true, name: true },
      });
      if (roleRecords.length !== desiredRoles.length) {
        throw new InternalServerErrorException('Configured role is missing');
      }

      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: roleRecords.map(({ id }) => ({ userId, roleId: id })),
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.auditService.record(
        {
          actorId,
          action: AuditAction.UserRoleChanged,
          target: { type: 'user', id: userId },
          metadata: {
            previousRoles: currentRoles,
            newRoles: desiredRoles,
          },
        },
        tx,
      );

      const updated = await tx.user.update({
        where: { id: userId },
        data: { updatedAt: new Date() },
        select: adminUserSelect,
      });
      return this.toResponse(updated);
    });
  }

  private buildWhere(query: ListAdminUsersQuery): Prisma.UserWhereInput {
    return {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.role
        ? { roles: { some: { role: { name: query.role } } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              {
                email: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                fullName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
  }

  private async findMutationTarget(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<AdminUserRecord> {
    const user = await tx.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: adminUserSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async assertAnotherActiveAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const otherActiveAdmins = await tx.user.count({
      where: {
        id: { not: userId },
        deletedAt: null,
        status: UserStatus.active,
        roles: { some: { role: { name: RoleName.platform_admin } } },
      },
    });
    if (otherActiveAdmins === 0) {
      throw new ConflictException(
        'The last active platform administrator cannot be removed or suspended',
      );
    }
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // Prevent two concurrent mutations from both observing another active admin.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === 2) throw error;
      }
    }

    throw new ConflictException('Concurrent user administration conflict');
  }

  private roleNames(user: AdminUserRecord): RoleName[] {
    return user.roles.map(({ role }) => role.name).sort();
  }

  private sameRoles(current: RoleName[], desired: RoleName[]): boolean {
    return (
      current.length === desired.length &&
      current.every((role, index) => role === desired[index])
    );
  }

  private toResponse(user: AdminUserRecord): AdminUserResponse {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      authProvider: user.authProvider,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roles: this.roleNames(user),
    };
  }
}
