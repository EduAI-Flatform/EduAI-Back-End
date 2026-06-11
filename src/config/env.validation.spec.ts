import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow('DATABASE_URL is required');
  });

  it('requires JWT secrets in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      }),
    ).toThrow('JWT_ACCESS_SECRET is required');
  });

  it('represents backend integration keys as typed config values', () => {
    const env = validateEnv({
      PORT: '4000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      R2_ACCOUNT_ID: 'account-id',
      R2_ACCESS_KEY_ID: 'access-key',
      R2_SECRET_ACCESS_KEY: 'secret-key',
      R2_BUCKET_NAME: 'eduai',
      R2_PUBLIC_URL: 'https://cdn.example.com',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'model-name',
    });

    expect(env).toMatchObject({
      PORT: 4000,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      R2_ACCOUNT_ID: 'account-id',
      R2_ACCESS_KEY_ID: 'access-key',
      R2_SECRET_ACCESS_KEY: 'secret-key',
      R2_BUCKET_NAME: 'eduai',
      R2_PUBLIC_URL: 'https://cdn.example.com',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'model-name',
    });
  });
});
