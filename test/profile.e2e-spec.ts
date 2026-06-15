import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RoleName } from '../generated/prisma/client';
import { configureApp } from '../src/app.setup';
import { AppLoggerService } from '../src/common/logging/app-logger.service';
import { AppConfigService } from '../src/config/app-config.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { ProfileController } from '../src/modules/profile/profile.controller';
import { ProfileService } from '../src/modules/profile/profile.service';

describe('Profile endpoints', () => {
  let app: INestApplication;
  const profile = {
    id: 'profile-id',
    userId: 'user-id',
    phoneNumber: null,
    dateOfBirth: null,
    bio: 'Bio',
    headline: 'Learner',
    location: null,
    websiteUrl: null,
    publicSlug: null,
    isPublic: false,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  };
  const profileService = {
    getCurrentProfile: jest.fn(),
    updateCurrentProfile: jest.fn(),
    addSkill: jest.fn(),
    deleteSkill: jest.fn(),
    createPortfolio: jest.fn(),
    updatePortfolio: jest.fn(),
    deletePortfolio: jest.fn(),
  };
  const jwtService = {
    verifyAsync: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        JwtAuthGuard,
        {
          provide: ProfileService,
          useValue: profileService,
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
    profileService.getCurrentProfile.mockResolvedValue(profile);
    profileService.updateCurrentProfile.mockResolvedValue({
      ...profile,
      bio: 'Updated bio',
      isPublic: true,
    });
    profileService.addSkill.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'user-id',
      name: 'Machine Learning',
      level: 'intermediate',
      category: 'AI',
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    profileService.deleteSkill.mockResolvedValue({ deleted: true });
    profileService.createPortfolio.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      userId: 'user-id',
      title: 'AI Learning Assistant',
      description: 'Project description',
      projectUrl: 'https://example.com/project',
      imageUrl: null,
      startDate: null,
      endDate: null,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      deletedAt: null,
    });
    profileService.updatePortfolio.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      userId: 'user-id',
      title: 'Updated project',
      description: null,
      projectUrl: 'https://example.com/project',
      imageUrl: null,
      startDate: null,
      endDate: null,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      deletedAt: null,
    });
    profileService.deletePortfolio.mockResolvedValue({ deleted: true });
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-id',
      email: 'student@example.com',
      roles: [RoleName.student],
    });
  });

  it('requires authentication for current profile reads', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .expect(401)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('UNAUTHORIZED');
      });

    expect(profileService.getCurrentProfile).not.toHaveBeenCalled();
  });

  it('returns the authenticated user profile', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', 'Bearer access-token')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          success: true,
          data: {
            id: 'profile-id',
            userId: 'user-id',
            bio: 'Bio',
          },
          message: 'OK',
        });
      });

    expect(profileService.getCurrentProfile).toHaveBeenCalledWith('user-id');
  });

  it('updates only the authenticated user profile', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/profile/me')
      .set('Authorization', 'Bearer access-token')
      .send({
        userId: 'other-user-id',
        bio: '  Updated bio  ',
        isPublic: true,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.bio).toBe('Updated bio');
        expect(body.data.isPublic).toBe(true);
      });

    expect(profileService.updateCurrentProfile).toHaveBeenCalledWith('user-id', {
      bio: 'Updated bio',
      isPublic: true,
    });
  });

  it('rejects invalid profile payloads', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/profile/me')
      .set('Authorization', 'Bearer access-token')
      .send({
        websiteUrl: 'not-a-url',
        publicSlug: 'Invalid Slug',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('BAD_REQUEST');
      });

    expect(profileService.updateCurrentProfile).not.toHaveBeenCalled();
  });

  it('adds a skill for the authenticated user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/profile/skills')
      .set('Authorization', 'Bearer access-token')
      .send({
        userId: 'other-user-id',
        name: '  Machine Learning  ',
        level: '  intermediate  ',
        category: '  AI  ',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.data.name).toBe('Machine Learning');
        expect(body.data.level).toBe('intermediate');
      });

    expect(profileService.addSkill).toHaveBeenCalledWith('user-id', {
      name: 'Machine Learning',
      level: 'intermediate',
      category: 'AI',
    });
  });

  it('rejects invalid skill payloads', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/profile/skills')
      .set('Authorization', 'Bearer access-token')
      .send({
        name: '',
        level: 123,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('BAD_REQUEST');
      });

    expect(profileService.addSkill).not.toHaveBeenCalled();
  });

  it('deletes a skill for the authenticated user', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/profile/skills/11111111-1111-4111-8111-111111111111')
      .set('Authorization', 'Bearer access-token')
      .expect(200)
      .expect({
        success: true,
        data: { deleted: true },
        message: 'OK',
      });

    expect(profileService.deleteSkill).toHaveBeenCalledWith(
      'user-id',
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('creates a portfolio item for the authenticated user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/profile/portfolio')
      .set('Authorization', 'Bearer access-token')
      .send({
        userId: 'other-user-id',
        title: '  AI Learning Assistant  ',
        description: '  Project description  ',
        projectUrl: 'https://example.com/project',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.data.title).toBe('AI Learning Assistant');
        expect(body.data.userId).toBe('user-id');
      });

    expect(profileService.createPortfolio).toHaveBeenCalledWith('user-id', {
      title: 'AI Learning Assistant',
      description: 'Project description',
      projectUrl: 'https://example.com/project',
    });
  });

  it('rejects invalid portfolio payloads', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/profile/portfolio')
      .set('Authorization', 'Bearer access-token')
      .send({
        title: '',
        projectUrl: 'not-a-url',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('BAD_REQUEST');
      });

    expect(profileService.createPortfolio).not.toHaveBeenCalled();
  });

  it('updates a portfolio item for the authenticated user', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/profile/portfolio/22222222-2222-4222-8222-222222222222')
      .set('Authorization', 'Bearer access-token')
      .send({
        userId: 'other-user-id',
        title: '  Updated project  ',
        description: null,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.title).toBe('Updated project');
      });

    expect(profileService.updatePortfolio).toHaveBeenCalledWith(
      'user-id',
      '22222222-2222-4222-8222-222222222222',
      {
        title: 'Updated project',
        description: null,
      },
    );
  });

  it('soft deletes a portfolio item for the authenticated user', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/profile/portfolio/22222222-2222-4222-8222-222222222222')
      .set('Authorization', 'Bearer access-token')
      .expect(200)
      .expect({
        success: true,
        data: { deleted: true },
        message: 'OK',
      });

    expect(profileService.deletePortfolio).toHaveBeenCalledWith(
      'user-id',
      '22222222-2222-4222-8222-222222222222',
    );
  });
});
