export type NodeEnvironment = 'development' | 'test' | 'production';
export type AiProviderName = 'gemini' | 'openai' | 'mock';
export type EmailProviderName = 'disabled' | 'preview' | 'resend';
export type PayosEnvironment = 'disabled' | 'production';

const OFFICIAL_PAYOS_API_BASE_URL = 'https://api-merchant.payos.vn';

export interface ValidatedEnv {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  PUBLIC_APP_URL?: string;
  CORS_ALLOWED_ORIGINS: string[];
  DATABASE_URL: string;
  REDIS_URL?: string;
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  OAUTH_STATE_SECRET?: string;
  OAUTH_FRONTEND_CALLBACK_URL?: string;
  OAUTH_STATE_TTL_SECONDS: number;
  OAUTH_TICKET_TTL_SECONDS: number;
  OAUTH_HTTP_TIMEOUT_MS: number;
  FACEBOOK_OAUTH_ENABLED: boolean;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_REDIRECT_URI?: string;
  FACEBOOK_GRAPH_API_VERSION?: string;
  ZALO_OAUTH_ENABLED: boolean;
  ZALO_APP_ID?: string;
  ZALO_APP_SECRET?: string;
  ZALO_REDIRECT_URI?: string;
  ZALO_AUTH_VERSION?: string;
  ZALO_GRAPH_API_VERSION: string;
  ZALO_OAUTH_SCOPES: string[];
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_PUBLIC_URL?: string;
  MAX_VIDEO_UPLOAD_SIZE: number;
  MAX_DOCUMENT_UPLOAD_SIZE: number;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_EMBEDDING_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  AI_TIMEOUT_MS: number;
  AI_MAX_RETRIES: number;
  AI_PROVIDER: AiProviderName;
  EMAIL_PROVIDER: EmailProviderName;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  MONITORING_ENABLED: boolean;
  MONITORING_ENDPOINT?: string;
  COMMERCE_IDEMPOTENCY_SECRET?: string;
  PAYOS_ENVIRONMENT: PayosEnvironment;
  PAYOS_CLIENT_ID?: string;
  PAYOS_API_KEY?: string;
  PAYOS_CHECKSUM_KEY?: string;
  PAYOS_API_BASE_URL: string;
  PAYOS_RETURN_URL?: string;
  PAYOS_CANCEL_URL?: string;
  PAYOS_WEBHOOK_URL?: string;
  PAYOS_TIMEOUT_MS: number;
}

export function loadBackendEnv(): ValidatedEnv {
  return validateEnv(process.env);
}

export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const nodeEnv = optionalString(config.NODE_ENV) ?? 'development';

  if (!isNodeEnvironment(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const firebaseProjectId = optionalString(config.FIREBASE_PROJECT_ID);
  const firebaseClientEmail = optionalString(config.FIREBASE_CLIENT_EMAIL);
  const firebasePrivateKey = optionalString(config.FIREBASE_PRIVATE_KEY);
  const firebaseConfigValues = [
    firebaseProjectId,
    firebaseClientEmail,
    firebasePrivateKey,
  ];

  if (
    firebaseConfigValues.some(Boolean) &&
    firebaseConfigValues.some((value) => !value)
  ) {
    throw new Error(
      'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY must be provided together',
    );
  }

  const facebookOAuthEnabled = parseBoolean(
    config.FACEBOOK_OAUTH_ENABLED,
    false,
    'FACEBOOK_OAUTH_ENABLED',
  );
  const zaloOAuthEnabled = parseBoolean(
    config.ZALO_OAUTH_ENABLED,
    false,
    'ZALO_OAUTH_ENABLED',
  );
  const oauthStateSecret = optionalString(config.OAUTH_STATE_SECRET);
  const oauthFrontendCallbackUrl = optionalUrl(
    config.OAUTH_FRONTEND_CALLBACK_URL,
    'OAUTH_FRONTEND_CALLBACK_URL',
  );
  const facebookClientId = optionalString(config.FACEBOOK_CLIENT_ID);
  const facebookClientSecret = optionalString(config.FACEBOOK_CLIENT_SECRET);
  const facebookRedirectUri = optionalUrl(
    config.FACEBOOK_REDIRECT_URI,
    'FACEBOOK_REDIRECT_URI',
  );
  const facebookGraphApiVersion = optionalString(
    config.FACEBOOK_GRAPH_API_VERSION,
  );
  const zaloAppId = optionalString(config.ZALO_APP_ID);
  const zaloAppSecret = optionalString(config.ZALO_APP_SECRET);
  const zaloRedirectUri = optionalUrl(
    config.ZALO_REDIRECT_URI,
    'ZALO_REDIRECT_URI',
  );
  const zaloAuthVersion = optionalString(config.ZALO_AUTH_VERSION);
  const zaloGraphApiVersion =
    optionalString(config.ZALO_GRAPH_API_VERSION) ?? 'v2.0';
  const zaloOAuthScopes = parseOAuthScopes(config.ZALO_OAUTH_SCOPES);

  validateOAuthConfiguration({
    nodeEnv,
    facebook: {
      enabled: facebookOAuthEnabled,
      clientId: facebookClientId,
      clientSecret: facebookClientSecret,
      redirectUri: facebookRedirectUri,
      graphApiVersion: facebookGraphApiVersion,
    },
    frontendCallbackUrl: oauthFrontendCallbackUrl,
    stateSecret: oauthStateSecret,
    zalo: {
      enabled: zaloOAuthEnabled,
      appId: zaloAppId,
      appSecret: zaloAppSecret,
      redirectUri: zaloRedirectUri,
      authVersion: zaloAuthVersion,
      graphApiVersion: zaloGraphApiVersion,
    },
  });

  const aiProvider = parseAiProvider(config.AI_PROVIDER);
  const emailProvider = parseEmailProvider(config.EMAIL_PROVIDER);
  const payosEnvironment = parsePayosEnvironment(config.PAYOS_ENVIRONMENT);
  const resendApiKey = optionalString(config.RESEND_API_KEY);
  const emailFrom = optionalString(config.EMAIL_FROM);
  const aiApiKey = optionalString(config.AI_API_KEY);
  const aiModel = optionalString(config.AI_MODEL);
  const aiEmbeddingModel = optionalString(config.AI_EMBEDDING_MODEL);
  const geminiApiKey = optionalString(config.GEMINI_API_KEY);
  const geminiModel = optionalString(config.GEMINI_MODEL);
  const geminiEmbeddingModel = optionalString(config.GEMINI_EMBEDDING_MODEL);

  const validated: ValidatedEnv = {
    NODE_ENV: nodeEnv,
    PORT: parsePort(config.PORT),
    PUBLIC_APP_URL: optionalUrl(config.PUBLIC_APP_URL, 'PUBLIC_APP_URL'),
    CORS_ALLOWED_ORIGINS: parseCorsOrigins(config.CORS_ALLOWED_ORIGINS),
    DATABASE_URL: requiredString(config.DATABASE_URL, 'DATABASE_URL'),
    REDIS_URL: optionalString(config.REDIS_URL),
    JWT_ACCESS_SECRET: requiredString(
      config.JWT_ACCESS_SECRET,
      'JWT_ACCESS_SECRET',
    ),
    JWT_REFRESH_SECRET: requiredString(
      config.JWT_REFRESH_SECRET,
      'JWT_REFRESH_SECRET',
    ),
    FIREBASE_PROJECT_ID: firebaseProjectId,
    FIREBASE_CLIENT_EMAIL: firebaseClientEmail,
    FIREBASE_PRIVATE_KEY: firebasePrivateKey,
    OAUTH_STATE_SECRET: oauthStateSecret,
    OAUTH_FRONTEND_CALLBACK_URL: oauthFrontendCallbackUrl,
    OAUTH_STATE_TTL_SECONDS: parseBoundedInteger(
      config.OAUTH_STATE_TTL_SECONDS,
      'OAUTH_STATE_TTL_SECONDS',
      300,
      60,
      900,
    ),
    OAUTH_TICKET_TTL_SECONDS: parseBoundedInteger(
      config.OAUTH_TICKET_TTL_SECONDS,
      'OAUTH_TICKET_TTL_SECONDS',
      120,
      60,
      600,
    ),
    OAUTH_HTTP_TIMEOUT_MS: parseBoundedInteger(
      config.OAUTH_HTTP_TIMEOUT_MS,
      'OAUTH_HTTP_TIMEOUT_MS',
      10000,
      1000,
      30000,
    ),
    FACEBOOK_OAUTH_ENABLED: facebookOAuthEnabled,
    FACEBOOK_CLIENT_ID: facebookClientId,
    FACEBOOK_CLIENT_SECRET: facebookClientSecret,
    FACEBOOK_REDIRECT_URI: facebookRedirectUri,
    FACEBOOK_GRAPH_API_VERSION: facebookGraphApiVersion,
    ZALO_OAUTH_ENABLED: zaloOAuthEnabled,
    ZALO_APP_ID: zaloAppId,
    ZALO_APP_SECRET: zaloAppSecret,
    ZALO_REDIRECT_URI: zaloRedirectUri,
    ZALO_AUTH_VERSION: zaloAuthVersion,
    ZALO_GRAPH_API_VERSION: zaloGraphApiVersion,
    ZALO_OAUTH_SCOPES: zaloOAuthScopes,
    R2_ACCOUNT_ID: optionalString(config.R2_ACCOUNT_ID),
    R2_ACCESS_KEY_ID: optionalString(config.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: optionalString(config.R2_SECRET_ACCESS_KEY),
    R2_BUCKET_NAME: optionalString(config.R2_BUCKET_NAME),
    R2_PUBLIC_URL: optionalString(config.R2_PUBLIC_URL),
    MAX_VIDEO_UPLOAD_SIZE: parsePositiveInteger(
      config.MAX_VIDEO_UPLOAD_SIZE,
      'MAX_VIDEO_UPLOAD_SIZE',
      2 * 1024 * 1024 * 1024,
    ),
    MAX_DOCUMENT_UPLOAD_SIZE: parsePositiveInteger(
      config.MAX_DOCUMENT_UPLOAD_SIZE,
      'MAX_DOCUMENT_UPLOAD_SIZE',
      50 * 1024 * 1024,
    ),
    OPENAI_API_KEY: optionalString(config.OPENAI_API_KEY),
    OPENAI_MODEL: optionalString(config.OPENAI_MODEL),
    OPENAI_EMBEDDING_MODEL: optionalString(config.OPENAI_EMBEDDING_MODEL),
    AI_API_KEY: aiApiKey,
    AI_MODEL: aiModel,
    AI_EMBEDDING_MODEL: aiEmbeddingModel,
    GEMINI_API_KEY:
      geminiApiKey ?? (aiProvider === 'gemini' ? aiApiKey : undefined),
    GEMINI_MODEL: geminiModel ?? (aiProvider === 'gemini' ? aiModel : undefined),
    GEMINI_EMBEDDING_MODEL:
      geminiEmbeddingModel ??
      (aiProvider === 'gemini' ? aiEmbeddingModel : undefined),
    AI_TIMEOUT_MS: parsePositiveInteger(
      config.AI_TIMEOUT_MS,
      'AI_TIMEOUT_MS',
      60000,
    ),
    AI_MAX_RETRIES: parseNonNegativeInteger(
      config.AI_MAX_RETRIES,
      'AI_MAX_RETRIES',
      2,
    ),
    AI_PROVIDER: aiProvider,
    EMAIL_PROVIDER: emailProvider,
    EMAIL_FROM: emailFrom,
    RESEND_API_KEY: resendApiKey,
    MONITORING_ENABLED: parseBoolean(config.MONITORING_ENABLED, false, 'MONITORING_ENABLED'),
    MONITORING_ENDPOINT: optionalUrl(config.MONITORING_ENDPOINT, 'MONITORING_ENDPOINT'),
    COMMERCE_IDEMPOTENCY_SECRET: optionalString(config.COMMERCE_IDEMPOTENCY_SECRET),
    PAYOS_ENVIRONMENT: payosEnvironment,
    PAYOS_CLIENT_ID: optionalString(config.PAYOS_CLIENT_ID),
    PAYOS_API_KEY: optionalString(config.PAYOS_API_KEY),
    PAYOS_CHECKSUM_KEY: optionalString(config.PAYOS_CHECKSUM_KEY),
    PAYOS_API_BASE_URL:
      optionalUrl(config.PAYOS_API_BASE_URL, 'PAYOS_API_BASE_URL') ??
      OFFICIAL_PAYOS_API_BASE_URL,
    PAYOS_RETURN_URL: optionalUrl(config.PAYOS_RETURN_URL, 'PAYOS_RETURN_URL'),
    PAYOS_CANCEL_URL: optionalUrl(config.PAYOS_CANCEL_URL, 'PAYOS_CANCEL_URL'),
    PAYOS_WEBHOOK_URL: optionalUrl(config.PAYOS_WEBHOOK_URL, 'PAYOS_WEBHOOK_URL'),
    PAYOS_TIMEOUT_MS: parseBoundedInteger(
      config.PAYOS_TIMEOUT_MS,
      'PAYOS_TIMEOUT_MS',
      10000,
      1000,
      60000,
    ),
  };

  if (validated.NODE_ENV === 'production' && validated.AI_PROVIDER === 'mock') {
    throw new Error('AI_PROVIDER=mock is not allowed in production');
  }

  if (validated.NODE_ENV === 'production' && validated.EMAIL_PROVIDER === 'preview') {
    throw new Error('EMAIL_PROVIDER=preview is not allowed in production');
  }

  if (validated.EMAIL_PROVIDER === 'resend') {
    if (!validated.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }
    if (!validated.EMAIL_FROM) {
      throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=resend');
    }
  }

  if (validated.MONITORING_ENABLED && !validated.MONITORING_ENDPOINT) {
    throw new Error('MONITORING_ENDPOINT is required when monitoring is enabled');
  }

  if (
    validated.NODE_ENV === 'production' &&
    (!validated.COMMERCE_IDEMPOTENCY_SECRET || validated.COMMERCE_IDEMPOTENCY_SECRET.length < 32)
  ) {
    throw new Error(
      'COMMERCE_IDEMPOTENCY_SECRET must be at least 32 characters in production',
    );
  }

  if (validated.PAYOS_ENVIRONMENT === 'production') {
    const requiredPayosVariables: Array<keyof ValidatedEnv> = [
      'PAYOS_CLIENT_ID',
      'PAYOS_API_KEY',
      'PAYOS_CHECKSUM_KEY',
      'PAYOS_RETURN_URL',
      'PAYOS_CANCEL_URL',
      'PAYOS_WEBHOOK_URL',
    ];
    const missing = requiredPayosVariables.filter((name) => !validated[name]);

    if (missing.length > 0) {
      throw new Error(
        `PAYOS production configuration requires ${missing.join(', ')}`,
      );
    }
    if (validated.NODE_ENV !== 'production') {
      throw new Error('PAYOS_ENVIRONMENT=production requires NODE_ENV=production');
    }
    if (validated.PAYOS_API_BASE_URL !== OFFICIAL_PAYOS_API_BASE_URL) {
      throw new Error(
        `PAYOS_API_BASE_URL must be ${OFFICIAL_PAYOS_API_BASE_URL}`,
      );
    }
    for (const name of [
      'PAYOS_RETURN_URL',
      'PAYOS_CANCEL_URL',
      'PAYOS_WEBHOOK_URL',
    ] as const) {
      const url = new URL(validated[name] as string);
      if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw new Error(`${name} must use https in PayOS production mode`);
      }
    }
  }

  return validated;
}

function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  const parsed = optionalString(value);
  if (parsed === undefined) return fallback;
  if (parsed === 'true') return true;
  if (parsed === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);

  if (!parsed) {
    throw new Error(`${name} is required`);
  }

  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: unknown): number {
  const rawPort = optionalString(value) ?? '3000';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseAiProvider(value: unknown): AiProviderName {
  const provider = optionalString(value) ?? 'gemini';

  if (provider !== 'gemini' && provider !== 'openai' && provider !== 'mock') {
    throw new Error('AI_PROVIDER must be gemini, openai, or mock');
  }

  return provider;
}

function parseEmailProvider(value: unknown): EmailProviderName {
  const provider = optionalString(value) ?? 'disabled';

  if (provider !== 'disabled' && provider !== 'preview' && provider !== 'resend') {
    throw new Error('EMAIL_PROVIDER must be disabled, preview, or resend');
  }

  return provider;
}

function parsePayosEnvironment(value: unknown): PayosEnvironment {
  const environment = optionalString(value) ?? 'disabled';

  if (environment !== 'disabled' && environment !== 'production') {
    throw new Error('PAYOS_ENVIRONMENT must be disabled or production');
  }

  return environment;
}

function parsePositiveInteger(value: unknown, name: string, fallback: number): number {
  const raw = optionalString(value);
  const parsed = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(
  value: unknown,
  name: string,
  fallback: number,
): number {
  const raw = optionalString(value);
  const parsed = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function parseBoundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionalString(value);
  const parsed = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function optionalUrl(value: unknown, name: string): string | undefined {
  const parsed = optionalString(value);
  if (!parsed) {
    return undefined;
  }

  try {
    const url = new URL(parsed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid http or https URL`);
  }
}

function parseCorsOrigins(value: unknown): string[] {
  const parsed = optionalString(value);
  if (!parsed) {
    return [];
  }

  return parsed.split(',').map((candidate) => {
    const origin = candidate.trim();

    try {
      const url = new URL(origin);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.pathname !== '/' ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error();
      }
      return url.origin;
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain only origins');
    }
  });
}

function parseOAuthScopes(value: unknown): string[] {
  const parsed = optionalString(value) ?? 'id_name,picture';
  const scopes = parsed
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const allowedScopes = new Set(['id_name', 'picture', 'email']);

  if (
    scopes.length === 0 ||
    scopes.some((scope) => !allowedScopes.has(scope)) ||
    !scopes.includes('id_name')
  ) {
    throw new Error(
      'ZALO_OAUTH_SCOPES must contain id_name and only id_name, picture, or email',
    );
  }

  return [...new Set(scopes)];
}

function validateOAuthConfiguration(input: {
  nodeEnv: NodeEnvironment;
  stateSecret?: string;
  frontendCallbackUrl?: string;
  facebook: {
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    graphApiVersion?: string;
  };
  zalo: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    redirectUri?: string;
    authVersion?: string;
    graphApiVersion: string;
  };
}): void {
  if (!input.facebook.enabled && !input.zalo.enabled) return;

  if (!input.stateSecret || input.stateSecret.length < 32) {
    throw new Error(
      'OAUTH_STATE_SECRET must be at least 32 characters when social OAuth is enabled',
    );
  }

  assertFixedFrontendCallbackUrl(input.frontendCallbackUrl);

  if (input.facebook.enabled) {
    const missing = [
      !input.facebook.clientId ? 'FACEBOOK_CLIENT_ID' : undefined,
      !input.facebook.clientSecret ? 'FACEBOOK_CLIENT_SECRET' : undefined,
      !input.facebook.redirectUri ? 'FACEBOOK_REDIRECT_URI' : undefined,
      !input.facebook.graphApiVersion ? 'FACEBOOK_GRAPH_API_VERSION' : undefined,
    ].filter((value): value is string => Boolean(value));

    if (missing.length > 0) {
      throw new Error(`Facebook OAuth configuration requires ${missing.join(', ')}`);
    }

    assertFixedProviderCallbackUrl(
      input.facebook.redirectUri,
      '/api/v1/auth/oauth/facebook/callback',
      'FACEBOOK_REDIRECT_URI',
    );
    assertOAuthVersion(input.facebook.graphApiVersion, 'FACEBOOK_GRAPH_API_VERSION');
  }

  if (input.zalo.enabled) {
    const missing = [
      !input.zalo.appId ? 'ZALO_APP_ID' : undefined,
      !input.zalo.appSecret ? 'ZALO_APP_SECRET' : undefined,
      !input.zalo.redirectUri ? 'ZALO_REDIRECT_URI' : undefined,
      !input.zalo.authVersion ? 'ZALO_AUTH_VERSION' : undefined,
    ].filter((value): value is string => Boolean(value));

    if (missing.length > 0) {
      throw new Error(`Zalo OAuth configuration requires ${missing.join(', ')}`);
    }

    assertFixedProviderCallbackUrl(
      input.zalo.redirectUri,
      '/api/v1/auth/oauth/zalo/callback',
      'ZALO_REDIRECT_URI',
    );
    assertOAuthVersion(input.zalo.authVersion, 'ZALO_AUTH_VERSION');
    if (input.zalo.authVersion !== 'v4') {
      throw new Error('ZALO_AUTH_VERSION must be v4 for Zalo Social API');
    }
    assertOAuthVersion(input.zalo.graphApiVersion, 'ZALO_GRAPH_API_VERSION');
  }

  if (input.nodeEnv === 'production') {
    const callbackUrls = [
      input.frontendCallbackUrl,
      input.facebook.enabled ? input.facebook.redirectUri : undefined,
      input.zalo.enabled ? input.zalo.redirectUri : undefined,
    ];

    if (callbackUrls.some((url) => url && !url.startsWith('https://'))) {
      throw new Error('OAuth callback URLs must use https in production');
    }
  }
}

function assertFixedFrontendCallbackUrl(value?: string): void {
  if (!value) {
    throw new Error(
      'OAUTH_FRONTEND_CALLBACK_URL must be the fixed /auth/callback path',
    );
  }

  const url = new URL(value);
  if (
    url.pathname !== '/auth/callback' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'OAUTH_FRONTEND_CALLBACK_URL must be the fixed /auth/callback path',
    );
  }
}

function assertFixedProviderCallbackUrl(
  value: string | undefined,
  pathname: string,
  name: string,
): void {
  if (!value) {
    throw new Error(`${name} must be an exact callback URL`);
  }

  const url = new URL(value);
  if (
    url.pathname !== pathname ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an exact callback URL`);
  }
}

function assertOAuthVersion(value: string | undefined, name: string): void {
  if (!value || !/^v\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must use a version such as v4 or v26.0`);
  }
}

function isNodeEnvironment(value: string): value is NodeEnvironment {
  return value === 'development' || value === 'test' || value === 'production';
}
