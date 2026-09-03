import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const paymentBase = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
  };

  it('keeps PayOS disabled by default without requiring provider secrets', () => {
    expect(validateEnv(paymentBase)).toMatchObject({
      PAYOS_API_BASE_URL: 'https://api-merchant.payos.vn',
      PAYOS_ENVIRONMENT: 'disabled',
      PAYOS_TIMEOUT_MS: 10000,
    });
  });

  it('requires complete production-only PayOS configuration when activated', () => {
    expect(() =>
      validateEnv({ ...paymentBase, PAYOS_ENVIRONMENT: 'production' }),
    ).toThrow('PAYOS production configuration requires');

    expect(() =>
      validateEnv({
        ...paymentBase,
        NODE_ENV: 'development',
        PAYOS_ENVIRONMENT: 'production',
        PAYOS_CLIENT_ID: 'client',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
        PAYOS_RETURN_URL: 'https://app.example/payments/return',
        PAYOS_CANCEL_URL: 'https://app.example/payments/cancel',
        PAYOS_WEBHOOK_URL: 'https://api.example/api/v1/payments/webhooks/payos',
      }),
    ).toThrow('PAYOS_ENVIRONMENT=production requires NODE_ENV=production');
  });

  it('accepts only the official PayOS API origin and HTTPS callback URLs', () => {
    const active = {
      ...paymentBase,
      NODE_ENV: 'production',
      COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32),
      PAYOS_ENVIRONMENT: 'production',
      PAYOS_CLIENT_ID: 'client',
      PAYOS_API_KEY: 'api-key',
      PAYOS_CHECKSUM_KEY: 'checksum-key',
      PAYOS_RETURN_URL: 'https://app.example/payments/return',
      PAYOS_CANCEL_URL: 'https://app.example/payments/cancel',
      PAYOS_WEBHOOK_URL: 'https://api.example/api/v1/payments/webhooks/payos',
    };

    expect(validateEnv(active)).toMatchObject({
      PAYOS_ENVIRONMENT: 'production',
      PAYOS_TIMEOUT_MS: 10000,
    });
    expect(() =>
      validateEnv({ ...active, PAYOS_RETURN_URL: 'http://app.example/return' }),
    ).toThrow('PAYOS_RETURN_URL must use https');
    expect(() =>
      validateEnv({ ...active, PAYOS_API_BASE_URL: 'https://proxy.example' }),
    ).toThrow('PAYOS_API_BASE_URL must be https://api-merchant.payos.vn');
    expect(() => validateEnv({ ...active, PAYOS_TIMEOUT_MS: '999' })).toThrow(
      'PAYOS_TIMEOUT_MS must be an integer between 1000 and 60000',
    );
  });

  it('requires a dedicated idempotency secret for permanent production Commerce', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://local/test',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
    };

    expect(() => validateEnv(base)).toThrow('COMMERCE_IDEMPOTENCY_SECRET');
    expect(() =>
      validateEnv({ ...base, COMMERCE_IDEMPOTENCY_SECRET: 'short' }),
    ).toThrow('COMMERCE_IDEMPOTENCY_SECRET');
    expect(() =>
      validateEnv({ ...base, COMMERCE_IDEMPOTENCY_SECRET: 's'.repeat(32) }),
    ).not.toThrow();
  });

  it('requires an endpoint only when monitoring is enabled', () => {
    const base = { DATABASE_URL: 'postgresql://local/test', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b' };
    expect(validateEnv(base).MONITORING_ENABLED).toBe(false);
    expect(() => validateEnv({ ...base, MONITORING_ENABLED: 'true' })).toThrow('MONITORING_ENDPOINT is required');
    expect(validateEnv({ ...base, MONITORING_ENABLED: 'true', MONITORING_ENDPOINT: 'https://monitor.example/events' }).MONITORING_ENDPOINT).toBe('https://monitor.example/events');
  });

  it('validates and normalizes the exact CORS origin allowlist', () => {
    expect(
      validateEnv({
        ...paymentBase,
        CORS_ALLOWED_ORIGINS:
          'https://eduai.giaoducso.org.vn, http://localhost:5173/',
      }).CORS_ALLOWED_ORIGINS,
    ).toEqual([
      'https://eduai.giaoducso.org.vn',
      'http://localhost:5173',
    ]);

    expect(() =>
      validateEnv({
        ...paymentBase,
        CORS_ALLOWED_ORIGINS: 'https://eduai.giaoducso.org.vn/login',
      }),
    ).toThrow('CORS_ALLOWED_ORIGINS must contain only origins');
  });

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
      AI_TIMEOUT_MS: 60000,
      AI_MAX_RETRIES: 2,
      PUBLIC_APP_URL: 'http://localhost:5173',
    });
  });

  it('defaults to Gemini and resolves its key/model from Gemini-specific variables', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      GEMINI_API_KEY: 'gemini-key',
      GEMINI_MODEL: 'configured-gemini-model',
      GEMINI_EMBEDDING_MODEL: 'configured-embedding-model',
    });

    expect(env).toMatchObject({
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-key',
      GEMINI_MODEL: 'configured-gemini-model',
      GEMINI_EMBEDDING_MODEL: 'configured-embedding-model',
      AI_TIMEOUT_MS: 60000,
      AI_MAX_RETRIES: 2,
    });
  });

  it('supports generic AI key/model fallback for Gemini only', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      AI_API_KEY: 'generic-key',
      AI_MODEL: 'generic-model',
      AI_EMBEDDING_MODEL: 'generic-embedding-model',
    });

    expect(env).toMatchObject({
      AI_PROVIDER: 'gemini',
      AI_API_KEY: 'generic-key',
      AI_MODEL: 'generic-model',
      AI_EMBEDDING_MODEL: 'generic-embedding-model',
      GEMINI_API_KEY: 'generic-key',
      GEMINI_MODEL: 'generic-model',
      GEMINI_EMBEDDING_MODEL: 'generic-embedding-model',
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
    ).toThrow('AI_PROVIDER must be gemini, openai, or mock');
  });

  it('rejects invalid AI timeout and retry settings', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
    };

    expect(() => validateEnv({ ...base, AI_TIMEOUT_MS: '0' })).toThrow(
      'AI_TIMEOUT_MS must be a positive integer',
    );
    expect(() => validateEnv({ ...base, AI_MAX_RETRIES: '-1' })).toThrow(
      'AI_MAX_RETRIES must be a non-negative integer',
    );
  });

  it('defaults notification email delivery to disabled', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
    });

    expect(env.EMAIL_PROVIDER).toBe('disabled');
  });

  it('requires an environment-only sender and key when Resend delivery is enabled', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
      JWT_ACCESS_SECRET: 'access-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      EMAIL_PROVIDER: 'resend',
    };

    expect(() => validateEnv(base)).toThrow('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    expect(() =>
      validateEnv({ ...base, RESEND_API_KEY: 'test-key' }),
    ).toThrow('EMAIL_FROM is required when EMAIL_PROVIDER=resend');
  });

  it('does not allow preview email delivery in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/eduai',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        EMAIL_PROVIDER: 'preview',
      }),
    ).toThrow('EMAIL_PROVIDER=preview is not allowed in production');
  });

  it('keeps Facebook and Zalo OAuth disabled without provider credentials', () => {
    expect(validateEnv(paymentBase)).toMatchObject({
      OAUTH_STATE_SECRET: undefined,
      OAUTH_FRONTEND_CALLBACK_URL: undefined,
      FACEBOOK_OAUTH_ENABLED: false,
      ZALO_OAUTH_ENABLED: false,
    });
  });

  it('requires complete OAuth configuration before enabling a provider', () => {
    expect(() =>
      validateEnv({
        ...paymentBase,
        FACEBOOK_OAUTH_ENABLED: 'true',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
      }),
    ).toThrow('Facebook OAuth configuration requires');

    expect(() =>
      validateEnv({
        ...paymentBase,
        ZALO_OAUTH_ENABLED: 'true',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
        ZALO_APP_ID: 'zalo-app-id',
        ZALO_APP_SECRET: 'zalo-app-secret',
      }),
    ).toThrow('Zalo OAuth configuration requires');
  });

  it('accepts local OAuth configuration and normalizes safe callback URLs', () => {
    const env = validateEnv({
      ...paymentBase,
      FACEBOOK_OAUTH_ENABLED: 'true',
      FACEBOOK_CLIENT_ID: 'facebook-client-id',
      FACEBOOK_CLIENT_SECRET: 'facebook-client-secret',
      FACEBOOK_REDIRECT_URI:
        'http://localhost:3000/api/v1/auth/oauth/facebook/callback',
      FACEBOOK_GRAPH_API_VERSION: 'v26.0',
      ZALO_OAUTH_ENABLED: 'true',
      ZALO_APP_ID: 'zalo-app-id',
      ZALO_APP_SECRET: 'zalo-app-secret',
      ZALO_REDIRECT_URI:
        'http://localhost:3000/api/v1/auth/oauth/zalo/callback',
      ZALO_AUTH_VERSION: 'v4',
      OAUTH_STATE_SECRET: 's'.repeat(32),
      OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback/',
    });

    expect(env).toMatchObject({
      FACEBOOK_OAUTH_ENABLED: true,
      FACEBOOK_GRAPH_API_VERSION: 'v26.0',
      ZALO_OAUTH_ENABLED: true,
      ZALO_AUTH_VERSION: 'v4',
      OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
    });
  });

  it('rejects OAuth redirect URLs that can escape the fixed callback routes', () => {
    const base = {
      ...paymentBase,
      FACEBOOK_OAUTH_ENABLED: 'true',
      FACEBOOK_CLIENT_ID: 'facebook-client-id',
      FACEBOOK_CLIENT_SECRET: 'facebook-client-secret',
      FACEBOOK_GRAPH_API_VERSION: 'v26.0',
      OAUTH_STATE_SECRET: 's'.repeat(32),
      OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
    };

    expect(() =>
      validateEnv({
        ...base,
        FACEBOOK_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/facebook/callback?next=https://evil.example',
      }),
    ).toThrow('FACEBOOK_REDIRECT_URI must be an exact callback URL');

    expect(() =>
      validateEnv({
        ...base,
        FACEBOOK_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/other/callback',
      }),
    ).toThrow('FACEBOOK_REDIRECT_URI must be an exact callback URL');

    expect(() =>
      validateEnv({
        ...base,
        FACEBOOK_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/facebook/callback',
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/login?next=/admin',
      }),
    ).toThrow('OAUTH_FRONTEND_CALLBACK_URL must be the fixed /auth/callback path');
  });

  it('requires HTTPS for OAuth callbacks in production', () => {
    expect(() =>
      validateEnv({
        ...paymentBase,
        NODE_ENV: 'production',
        COMMERCE_IDEMPOTENCY_SECRET: 'c'.repeat(32),
        FACEBOOK_OAUTH_ENABLED: 'true',
        FACEBOOK_CLIENT_ID: 'facebook-client-id',
        FACEBOOK_CLIENT_SECRET: 'facebook-client-secret',
        FACEBOOK_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/facebook/callback',
        FACEBOOK_GRAPH_API_VERSION: 'v26.0',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
      }),
    ).toThrow('OAuth callback URLs must use https in production');
  });

  it('rejects malformed Zalo API versions before any provider request', () => {
    expect(() =>
      validateEnv({
        ...paymentBase,
        ZALO_OAUTH_ENABLED: 'true',
        ZALO_APP_ID: 'zalo-app-id',
        ZALO_APP_SECRET: 'zalo-app-secret',
        ZALO_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/zalo/callback',
        ZALO_AUTH_VERSION: 'v4',
        ZALO_GRAPH_API_VERSION: 'https://evil.example',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
      }),
    ).toThrow('ZALO_GRAPH_API_VERSION must use a version');
  });

  it('rejects the legacy Zalo OAuth version that does not implement the V4 PKCE flow', () => {
    expect(() =>
      validateEnv({
        ...paymentBase,
        ZALO_OAUTH_ENABLED: 'true',
        ZALO_APP_ID: 'zalo-app-id',
        ZALO_APP_SECRET: 'zalo-app-secret',
        ZALO_REDIRECT_URI:
          'http://localhost:3000/api/v1/auth/oauth/zalo/callback',
        ZALO_AUTH_VERSION: 'v3',
        ZALO_GRAPH_API_VERSION: 'v2.0',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_FRONTEND_CALLBACK_URL: 'http://localhost:5173/auth/callback',
      }),
    ).toThrow('ZALO_AUTH_VERSION must be v4');
  });
});
