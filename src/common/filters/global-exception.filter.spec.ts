import { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  it.each(['P2021', 'P2022'])('classifies schema drift (%s) without exposing banking arguments', code => {
    const logger = { error: jest.fn() }, json = jest.fn();
    const host = { switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', originalUrl: '/api/v1/wallet/gds' }),
      getResponse: () => ({ status: jest.fn().mockReturnThis(), json }),
    }) } as unknown as ArgumentsHost;
    const error = Object.assign(new Error('Prisma arguments: 00123456789 PRIVATE NAME'), { code, meta: { table: 'private_table' } });
    new GlobalExceptionFilter('development', logger as never).catch(error, host);
    expect(logger.error).toHaveBeenCalledWith('critical request error', 'Banking request failed; details redacted', 'GlobalExceptionFilter', expect.objectContaining({ failureClass: 'DATABASE_SCHEMA_OUTDATED' }));
    expect(JSON.stringify([logger.error.mock.calls, json.mock.calls])).not.toMatch(/00123456789|PRIVATE NAME|private_table/);
  });
  it('redacts banking database error details from logs and development responses', () => {
    const logger = { error: jest.fn() }, json = jest.fn();
    const host = { switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/admin/wallet/gds/withdrawals/x/verify-account' }),
      getResponse: () => ({ status: jest.fn().mockReturnThis(), json }),
    }) } as unknown as ArgumentsHost;
    new GlobalExceptionFilter('development', logger as never).catch(new Error('Prisma create accountNumber: 00123456789 accountHolder: PRIVATE NAME'), host);
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/00123456789|PRIVATE NAME/);
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/00123456789|PRIVATE NAME/);
  });
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

  it('classifies production constraint-name targets', () => {
    const logger = { error: jest.fn() };
    const status = jest.fn().mockReturnThis();
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/api/v1/assignments/x/submissions' }),
        getResponse: () => ({ status, json: jest.fn() }),
      }),
    } as unknown as ArgumentsHost;
    const exception = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'submissions_assignment_id_user_id_version_key' },
    });

    new GlobalExceptionFilter('production', logger as never).catch(exception, host);

    expect(logger.error).toHaveBeenCalledWith(
      'critical request error',
      expect.any(String),
      'GlobalExceptionFilter',
      expect.objectContaining({ failureClass: 'ASSIGNMENT_VERSION_CONFLICT' }),
    );
  });

  it('classifies a submission conflict from Prisma model metadata', () => {
    const logger = { error: jest.fn() };
    const status = jest.fn().mockReturnThis();
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/api/v1/assignments/x/submissions' }),
        getResponse: () => ({ status, json: jest.fn() }),
      }),
    } as unknown as ArgumentsHost;
    const exception = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { modelName: 'Submission', target: null },
    });

    new GlobalExceptionFilter('production', logger as never).catch(exception, host);

    expect(logger.error).toHaveBeenCalledWith(
      'critical request error',
      expect.any(String),
      'GlobalExceptionFilter',
      expect.objectContaining({ failureClass: 'ASSIGNMENT_VERSION_CONFLICT' }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('modelName');
  });
});
