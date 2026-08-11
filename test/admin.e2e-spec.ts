import { ConflictException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import {
  ModerationStatus,
  RoleName,
  UserStatus,
} from '../generated/prisma/client';
import { configureApp } from '../src/app.setup';
import { AppLoggerService } from '../src/common/logging/app-logger.service';
import { AuditService } from '../src/common/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AdminUserService } from '../src/modules/admin/admin-user.service';
import { AdminService } from '../src/modules/admin/admin.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/modules/auth/guards/roles.guard';
import {
  AdminModerationController,
  ModerationController,
} from '../src/modules/moderation/moderation.controller';
import {
  ModerationAction,
  ModerationService,
  ModerationTargetType,
} from '../src/modules/moderation/moderation.service';
import { PrismaService } from '../src/prisma/prisma.service';

const overview = {
  users: { total: 3, active: 3, inactive: 0, suspended: 0 },
  roles: { student: 1, instructor: 1, platformAdmin: 1 },
};
const auditLogs = {
  items: [],
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 0,
};
const adminUsers = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'learner@example.com',
      fullName: 'Learner Example',
      status: UserStatus.active,
      authProvider: 'local',
      emailVerified: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      roles: [RoleName.student],
    },
  ],
  page: 1,
  pageSize: 25,
  total: 1,
  totalPages: 1,
};
const moderationItem = {
  id: '44444444-4444-4444-8444-444444444444',
  targetType: ModerationTargetType.Course,
  title: 'Review target',
  content: 'Non-sensitive review content',
  owner: {
    id: '55555555-5555-4555-8555-555555555555',
    fullName: 'Content owner',
  },
  moderationStatus: ModerationStatus.clear,
  moderationReason: null,
  moderatedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-02T00:00:00.000Z'),
};

describe('Admin overview endpoint', () => {
  let app: INestApplication;
  const adminService = {
    getOverview: jest.fn(),
  };
  const auditService = {
    list: jest.fn(),
  };
  const adminUserService = {
    listUsers: jest.fn(),
    getUser: jest.fn(),
    setStatus: jest.fn(),
    setRoles: jest.fn(),
  };
  const moderationService = {
    list: jest.fn(),
    getDetail: jest.fn(),
    moderate: jest.fn(),
    getOwnerStatus: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
  };
  const prismaService = {
    user: { findUnique: jest.fn() },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AdminController,
        AdminModerationController,
        ModerationController,
      ],
      providers: [
        Reflector,
        JwtAuthGuard,
        RolesGuard,
        {
          provide: AdminService,
          useValue: adminService,
        },
        {
          provide: AuditService,
          useValue: auditService,
        },
        {
          provide: AdminUserService,
          useValue: adminUserService,
        },
        {
          provide: ModerationService,
          useValue: moderationService,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: AppConfigService,
          useValue: {
            jwt: { accessSecret: 'test-access-secret' },
          },
        },
        {
          provide: PrismaService,
          useValue: prismaService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, 'test', new AppLoggerService(jest.fn()));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    adminService.getOverview.mockResolvedValue(overview);
    auditService.list.mockResolvedValue(auditLogs);
    adminUserService.listUsers.mockResolvedValue(adminUsers);
    adminUserService.getUser.mockResolvedValue(adminUsers.items[0]);
    adminUserService.setStatus.mockResolvedValue({
      ...adminUsers.items[0],
      status: UserStatus.suspended,
    });
    adminUserService.setRoles.mockResolvedValue({
      ...adminUsers.items[0],
      roles: [RoleName.instructor, RoleName.student],
    });
    moderationService.list.mockResolvedValue({
      items: [moderationItem],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    moderationService.getDetail.mockResolvedValue({
      item: moderationItem,
      history: [],
    });
    moderationService.moderate.mockResolvedValue({
      ...moderationItem,
      moderationStatus: ModerationStatus.rejected,
      moderationReason: 'Confirmed policy violation',
    });
    moderationService.getOwnerStatus.mockResolvedValue({
      id: moderationItem.id,
      targetType: moderationItem.targetType,
      moderationStatus: moderationItem.moderationStatus,
      moderationReason: null,
      moderatedAt: null,
    });
    jwtService.verifyAsync.mockImplementation(async (token: string) => {
      const roleByToken: Record<string, RoleName> = {
        'student-token': RoleName.student,
        'instructor-token': RoleName.instructor,
        'admin-token': RoleName.platform_admin,
      };

      return {
        sub: `${roleByToken[token]}-id`,
        roles: [roleByToken[token]],
      };
    });
    prismaService.user.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        const role = where.id.replace(/-id$/, '') as RoleName;
        return {
          id: where.id,
          email: `${role}@example.com`,
          status: UserStatus.active,
          deletedAt: null,
          roles: [{ role: { name: role } }],
        };
      },
    );
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/reports/overview')
      .expect(401)
      .expect(({ body }) => {
        expect(body.error.code).toBe('UNAUTHORIZED');
      });

    expect(adminService.getOverview).not.toHaveBeenCalled();
  });

  it.each(['student-token', 'instructor-token'])(
    'rejects the %s role',
    async (token) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .set('Authorization', `Bearer ${token}`)
        .expect(403)
        .expect(({ body }) => {
          expect(body.error.code).toBe('FORBIDDEN');
        });

      expect(adminService.getOverview).not.toHaveBeenCalled();
    },
  );

  it('returns database aggregates to a platform administrator', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/reports/overview')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect({
        success: true,
        data: overview,
        message: 'OK',
      });

    expect(adminService.getOverview).toHaveBeenCalledTimes(1);
  });

  it.each(['student-token', 'instructor-token'])(
    'rejects the %s role from audit records',
    async (token) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(auditService.list).not.toHaveBeenCalled();
    },
  );

  it('returns filtered audit records to a platform administrator', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs?page=1&pageSize=25&search=course')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect({
        success: true,
        data: auditLogs,
        message: 'OK',
      });

    expect(auditService.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 25, search: 'course' }),
    );
  });

  it('returns a filtered sanitized user page to a platform administrator', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/users?page=1&pageSize=25&search=learner&role=student&status=active')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(adminUsers);
        expect(JSON.stringify(body.data)).not.toMatch(
          /passwordHash|refreshToken|firebaseUid|deletedAt/,
        );
      });

    expect(adminUserService.listUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        search: 'learner',
        role: RoleName.student,
        status: UserStatus.active,
      }),
    );
  });

  it('returns sanitized user detail and validates list boundaries', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/users/11111111-1111-4111-8111-111111111111')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(adminUsers.items[0]);
      });

    await request(app.getHttpServer())
      .get('/api/v1/admin/users?pageSize=101')
      .set('Authorization', 'Bearer admin-token')
      .expect(400);
  });

  it.each(['student-token', 'instructor-token'])(
    'rejects the %s role from user administration',
    async (token) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    },
  );

  it('updates status and roles for a platform administrator', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/status')
      .set('Authorization', 'Bearer admin-token')
      .send({ status: UserStatus.suspended })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/roles')
      .set('Authorization', 'Bearer admin-token')
      .send({ roles: [RoleName.student, RoleName.instructor] })
      .expect(200);

    expect(adminUserService.setStatus).toHaveBeenCalledWith(
      `${RoleName.platform_admin}-id`,
      '11111111-1111-4111-8111-111111111111',
      UserStatus.suspended,
    );
    expect(adminUserService.setRoles).toHaveBeenCalledWith(
      `${RoleName.platform_admin}-id`,
      '11111111-1111-4111-8111-111111111111',
      [RoleName.student, RoleName.instructor],
    );
  });

  it('rejects invalid or unauthorized user mutations', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/roles')
      .set('Authorization', 'Bearer admin-token')
      .send({ roles: [] })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/status')
      .set('Authorization', 'Bearer student-token')
      .send({ status: UserStatus.suspended })
      .expect(403);
  });

  it('returns conflict when the last administrator safeguard rejects a mutation', async () => {
    adminUserService.setRoles.mockRejectedValueOnce(
      new ConflictException('The last administrator cannot be removed'),
    );

    await request(app.getHttpServer())
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/roles')
      .set('Authorization', 'Bearer admin-token')
      .send({ roles: [RoleName.student] })
      .expect(409)
      .expect(({ body }) => {
        expect(body.error.code).toBe('CONFLICT');
      });
  });

  it.each(['student-token', 'instructor-token'])(
    'rejects the %s role from moderation administration',
    async (token) => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/moderation?targetType=course')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/moderation/course/${moderationItem.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          action: ModerationAction.Reject,
          reason: 'Confirmed policy violation',
        })
        .expect(403);

      expect(moderationService.list).not.toHaveBeenCalled();
      expect(moderationService.moderate).not.toHaveBeenCalled();
    },
  );

  it('returns a validated moderation queue and detail to an administrator', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/moderation?targetType=course&status=clear&page=1&pageSize=25')
      .set('Authorization', 'Bearer admin-token')
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/moderation/course/${moderationItem.id}`)
      .set('Authorization', 'Bearer admin-token')
      .expect(200);

    expect(moderationService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: ModerationTargetType.Course,
        status: ModerationStatus.clear,
        page: 1,
        pageSize: 25,
      }),
    );
    expect(moderationService.getDetail).toHaveBeenCalledWith(
      ModerationTargetType.Course,
      moderationItem.id,
    );
  });

  it('requires a reason and delegates an administrator moderation transition', async () => {
    const route = `/api/v1/admin/moderation/course/${moderationItem.id}`;
    await request(app.getHttpServer())
      .patch(route)
      .set('Authorization', 'Bearer admin-token')
      .send({ action: ModerationAction.Reject, reason: '  ' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(route)
      .set('Authorization', 'Bearer admin-token')
      .send({
        action: ModerationAction.Reject,
        reason: 'Confirmed policy violation',
      })
      .expect(200);

    expect(moderationService.moderate).toHaveBeenCalledWith(
      `${RoleName.platform_admin}-id`,
      ModerationTargetType.Course,
      moderationItem.id,
      {
        action: ModerationAction.Reject,
        reason: 'Confirmed policy violation',
      },
    );
  });

  it('returns moderation status through an authenticated owner route', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/moderation/course/${moderationItem.id}/status`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/moderation/course/${moderationItem.id}/status`)
      .set('Authorization', 'Bearer instructor-token')
      .expect(200);

    expect(moderationService.getOwnerStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${RoleName.instructor}-id`,
        roles: [RoleName.instructor],
      }),
      ModerationTargetType.Course,
      moderationItem.id,
    );
  });
});
