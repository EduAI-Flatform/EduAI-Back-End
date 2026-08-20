import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AppModule } from '../src/app.module';
import { AppLoggerService, LOG_WRITER } from '../src/common/logging/app-logger.service';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Health endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
      })
      .overrideProvider(LOG_WRITER)
      .useValue(jest.fn())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService).app.nodeEnv, app.get(AppLoggerService));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns ok at GET /health', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect('Content-Security-Policy', /frame-ancestors 'none'/)
      .expect('Referrer-Policy', 'no-referrer')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect('X-Frame-Options', 'DENY')
      .expect(({ body }) => {
        expect(body.success).toBe(true);
        expect(body.message).toBe('OK');
        expect(body.data.status).toBe('ok');
        expect(['disabled', 'error', 'ok']).toContain(body.data.redis.status);
      });
  });

  it('applies default-deny authentication to protected endpoints', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401)
      .expect(({ body }) => {
        expect(body.error.code).toBe('UNAUTHORIZED');
      });
  });

  it('rate-limits repeated login attempts before validation', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({})
        .expect(400);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(429)
      .expect(({ body }) => {
        expect(body.error.message).toBe('Request rate limit exceeded');
      });
  });
});
