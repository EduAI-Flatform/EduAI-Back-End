import { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  it('logs a fixed assignment conflict class without exposing constraint metadata', () => {
    const logger = { error: jest.fn() };
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/assignments/x/submissions' }),
        getResponse: () => ({ status, json }),
      }),
    } as unknown as ArgumentsHost;
    const exception = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['assignment_id', 'user_id', 'version'] },
    });

    new GlobalExceptionFilter('production', logger as never).catch(exception, host);

    expect(logger.error).toHaveBeenCalledWith(
      'critical request error',
      expect.any(String),
      'GlobalExceptionFilter',
      expect.objectContaining({ failureClass: 'ASSIGNMENT_VERSION_CONFLICT' }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('assignment_id');
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
  });
});
