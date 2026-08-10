import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RoleName } from '../generated/prisma/client';
import { configureApp } from '../src/app.setup';
import { AppLoggerService } from '../src/common/logging/app-logger.service';
import { AuditService } from '../src/common/audit/audit.service';
import { AppConfigService } from '../src/config/app-config.service';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AdminService } from '../src/modules/admin/admin.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/modules/auth/guards/roles.guard';

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

describe('Admin overview endpoint', () => {
  let app: INestApplication;
  const adminService = {
    getOverview: jest.fn(),
  };
  const auditService = {
    list: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
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
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: AppConfigService,
          useValue: {
            jwt: { accessSecret: 'test-access-secret' },
          },
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
});
