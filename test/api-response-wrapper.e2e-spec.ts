import { Controller, Get, INestApplication, StreamableFile } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { Readable } from 'stream';
import { configureApp } from '../src/app.setup';
import { AppLoggerService } from '../src/common/logging/app-logger.service';

@Controller('response-test')
class ResponseTestController {
  @Get('object')
  getObject(): { id: string } {
    return { id: 'sample-id' };
  }

  @Get('file')
  getFile(): StreamableFile {
    return new StreamableFile(Readable.from(['file-content']));
  }
}

describe('API response wrapper', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ResponseTestController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, 'test', new AppLoggerService(jest.fn()));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('wraps successful JSON responses in the standard API shape', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/response-test/object')
      .expect(200)
      .expect({
        success: true,
        data: {
          id: 'sample-id',
        },
        message: 'OK',
      });
  });

  it('does not wrap stream responses', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/response-test/file')
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding('utf8');
        let data = '';
        response.on('data', (chunk: string) => {
          data += chunk;
        });
        response.on('end', () => callback(null, data));
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toBe('file-content');
      });
  });
});
