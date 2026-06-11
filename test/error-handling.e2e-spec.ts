import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsEmail } from 'class-validator';
import * as request from 'supertest';
import { configureApp } from '../src/app.setup';

class ValidationBodyDto {
  @IsEmail()
  email!: string;
}

@Controller('error-test')
class ErrorTestController {
  @Get('unexpected')
  throwUnexpected(): void {
    throw new Error('internal implementation detail');
  }

  @Post('validation')
  validateBody(@Body() body: ValidationBodyDto): ValidationBodyDto {
    return body;
  }
}

describe('Global error handling', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ErrorTestController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, 'production');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the standard API error shape without stack traces', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/error-test/unexpected')
      .expect(500)
      .expect(({ body }) => {
        expect(body).toEqual({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error',
          },
        });
        expect(JSON.stringify(body)).not.toContain('stack');
        expect(JSON.stringify(body)).not.toContain('internal implementation detail');
      });
  });

  it('returns readable validation messages', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/error-test/validation')
      .send({ email: 'not-an-email' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('BAD_REQUEST');
        expect(body.error.message).toContain('email must be an email');
      });
  });
});
