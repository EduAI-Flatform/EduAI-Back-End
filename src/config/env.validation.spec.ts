import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow('DATABASE_URL is required');
  });

  it('requires JWT secrets', () => {
    expect(() =>
      validateEnv({
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
      FIREBASE_PROJECT_ID: 'eduai-project',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'private-key',
      R2_ACCOUNT_ID: 'account-id',
      R2_ACCESS_KEY_ID: 'access-key',
      R2_SECRET_ACCESS_KEY: 'secret-key',
      R2_BUCKET_NAME: 'eduai',
      R2_PUBLIC_URL: 'https://cdn.example.com',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'model-name',
      AI_PROVIDER: 'mock',
      PUBLIC_APP_URL: 'http://localhost:5173',
    });

    expect(env).toMatchObject({
      PORT: 4000,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      FIREBASE_PROJECT_ID: 'eduai-project',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'private-key',
      R2_ACCOUNT_ID: 'account-id',
      R2_ACCESS_KEY_ID: 'access-key',
      R2_SECRET_ACCESS_KEY: 'secret-key',
      R2_BUCKET_NAME: 'eduai',
      R2_PUBLIC_URL: 'https://cdn.example.com',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'model-name',
      AI_PROVIDER: 'mock',
      PUBLIC_APP_URL: 'http://localhost:5173',
    });
  });

  it('allows Firebase configuration to be omitted as a complete optional integration', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      }),
    ).not.toThrow();
  });

  it('rejects partial Firebase configuration', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        FIREBASE_PROJECT_ID: 'eduai-project',
      }),
    ).toThrow(
      'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY must be provided together',
    );
  });

  it('rejects the mock AI provider in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        AI_PROVIDER: 'mock',
      }),
    ).toThrow('AI_PROVIDER=mock is not allowed in production');
  });

  it('rejects unknown AI providers', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        AI_PROVIDER: 'local-llm',
      }),
    ).toThrow('AI_PROVIDER must be openai or mock');
  });
});
