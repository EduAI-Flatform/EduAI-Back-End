import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthProvider,
  Prisma,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

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
      roles: user.roles.map(({ role }) => role.name).sort(),
    };
  }
}
