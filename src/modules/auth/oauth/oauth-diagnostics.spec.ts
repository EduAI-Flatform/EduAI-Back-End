import { buildOAuthDiagnosticMetadata } from './oauth-diagnostics';

describe('OAuth diagnostics', () => {
  it('keeps Prisma driver causes useful without logging raw database details', () => {
    const error = Object.assign(new Error('database detail with secret'), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'TableDoesNotExist',
        table: 'oauth_accounts',
        originalCode: '42P01',
        message: 'postgres detail with secret',
      },
    });

    const metadata = buildOAuthDiagnosticMetadata(
      'facebook',
      'account_resolution',
      error,
    );

    expect(metadata).toMatchObject({
      exceptionClass: 'Error',
      provider: 'facebook',
      stage: 'account_resolution',
      driverAdapterKind: 'TableDoesNotExist',
      driverAdapterCode: '42P01',
    });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('oauth_accounts');
  });
});
