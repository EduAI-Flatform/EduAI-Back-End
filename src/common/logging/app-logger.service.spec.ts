import { AppLoggerService } from './app-logger.service';

describe('AppLoggerService', () => {
  it('writes structured logs with timestamp and context', () => {
    const writer = jest.fn();
    const logger = new AppLoggerService(writer);

    logger.log('request completed', 'HttpRequest', {
      method: 'GET',
      path: '/api/v1/health',
    });

    const entry = JSON.parse(writer.mock.calls[0][0]);

    expect(entry).toMatchObject({
      level: 'log',
      message: 'request completed',
      context: 'HttpRequest',
      method: 'GET',
      path: '/api/v1/health',
    });
    expect(entry.timestamp).toEqual(expect.any(String));
  });

  it('redacts sensitive values from metadata', () => {
    const writer = jest.fn();
    const logger = new AppLoggerService(writer);

    logger.error('critical failure', 'Auth', {
      password: 'secret',
      accessToken: 'token',
      nested: {
        refresh_secret: 'refresh',
      },
    });

    const entry = JSON.parse(writer.mock.calls[0][0]);

    expect(entry.password).toBe('[REDACTED]');
    expect(entry.accessToken).toBe('[REDACTED]');
    expect(entry.nested.refresh_secret).toBe('[REDACTED]');
  });
});
