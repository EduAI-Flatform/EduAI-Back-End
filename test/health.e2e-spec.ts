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
      .expect(({ body }) => {
        expect(body.success).toBe(true);
        expect(body.message).toBe('OK');
        expect(body.data.status).toBe('ok');
        expect(['disabled', 'error', 'ok']).toContain(body.data.redis.status);
      });
  });
});
