import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RoleName, UserStatus } from '../generated/prisma/client';
import { configureApp } from '../src/app.setup';
import { AppLoggerService } from '../src/common/logging/app-logger.service';
import { AppConfigService } from '../src/config/app-config.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/modules/auth/guards/roles.guard';

const user = {
  id: 'user-id',
  email: 'student@example.com',
  fullName: 'Student User',
  status: UserStatus.active,
  roles: [RoleName.student],
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('Auth flow endpoints', () => {
  let app: INestApplication;
  const authService = {
    register: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    getCurrentUser: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        Reflector,
        JwtAuthGuard,
        RolesGuard,
        {
          provide: AuthService,
          useValue: authService,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: AppConfigService,
          useValue: {
            jwt: {
              accessSecret: 'test-access-secret',
            },
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
    authService.register.mockResolvedValue({ user });
    authService.login.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      user,
    });
    authService.logout.mockResolvedValue({ loggedOut: true });
    authService.getCurrentUser.mockResolvedValue(user);
    jwtService.verifyAsync.mockResolvedValue({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
  });

  it('registers with validated input and returns a sanitized user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: '  STUDENT@EXAMPLE.COM ',
        password: 'Str0ngPassword!123',
        fullName: ' Student User ',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.success).toBe(true);
        expect(body.data.user.email).toBe(user.email);
        expect(JSON.stringify(body)).not.toContain('password');
      });

    expect(authService.register).toHaveBeenCalledWith({
      email: 'student@example.com',
      password: 'Str0ngPassword!123',
      fullName: 'Student User',
    });
  });

  it('rejects invalid register payloads', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'invalid-email',
        password: 'short',
        fullName: '',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('BAD_REQUEST');
      });

    expect(authService.register).not.toHaveBeenCalled();
  });

  it('logs in, logs out, and preserves the standard response envelope', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: user.email,
        password: 'Str0ngPassword!123',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            tokenType: 'Bearer',
            expiresIn: 900,
          },
          message: 'OK',
        });
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: 'refresh-token' })
      .expect(200)
      .expect({
        success: true,
        data: { loggedOut: true },
        message: 'OK',
      });
  });

  it('requires a bearer token for the current user endpoint', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('UNAUTHORIZED');
      });

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer access-token')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.email).toBe(user.email);
      });

    expect(authService.getCurrentUser).toHaveBeenCalledWith(user.id);
  });

  it('enforces RBAC on admin-only routes', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/admin-test')
      .set('Authorization', 'Bearer student-token')
      .expect(403)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('FORBIDDEN');
      });

    jwtService.verifyAsync.mockResolvedValueOnce({
      sub: 'admin-id',
      email: 'admin@example.com',
      roles: [RoleName.platform_admin],
    });

    await request(app.getHttpServer())
      .get('/api/v1/auth/admin-test')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect({
        success: true,
        data: { ok: true },
        message: 'OK',
      });
  });
});
