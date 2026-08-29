import { configureApp } from './app.setup';

describe('configureApp', () => {
  it('allows the bounded Idempotency-Key header for approved CORS origins', () => {
    const app = {
      enableCors: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
      getHttpAdapter: jest.fn().mockReturnValue({
        getInstance: jest.fn().mockReturnValue({ set: jest.fn() }),
      }),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      useGlobalPipes: jest.fn(),
    };
    const logger = {};

    configureApp(app as never, 'test', logger as never);

    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHeaders: expect.arrayContaining(['Idempotency-Key']),
      }),
    );
  });

  it('allows only the validated production frontend origins', () => {
    const app = {
      enableCors: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
      getHttpAdapter: jest.fn().mockReturnValue({
        getInstance: jest.fn().mockReturnValue({ set: jest.fn() }),
      }),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      useGlobalPipes: jest.fn(),
    };

    configureApp(
      app as never,
      'production',
      {} as never,
      undefined,
      ['https://eduai.giaoducso.org.vn'],
    );

    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: true,
        origin: ['https://eduai.giaoducso.org.vn'],
      }),
    );
  });
});
