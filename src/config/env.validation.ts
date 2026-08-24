export type NodeEnvironment = 'development' | 'test' | 'production';
export type AiProviderName = 'gemini' | 'openai' | 'mock';
export type EmailProviderName = 'disabled' | 'preview' | 'resend';

export interface ValidatedEnv {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  PUBLIC_APP_URL?: string;
  DATABASE_URL: string;
  REDIS_URL?: string;
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
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
  COMMERCE_ENABLED: boolean;
  COMMERCE_IDEMPOTENCY_SECRET?: string;
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

  const aiProvider = parseAiProvider(config.AI_PROVIDER);
  const emailProvider = parseEmailProvider(config.EMAIL_PROVIDER);
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
    COMMERCE_ENABLED: parseBoolean(config.COMMERCE_ENABLED, false, 'COMMERCE_ENABLED'),
    COMMERCE_IDEMPOTENCY_SECRET: optionalString(config.COMMERCE_IDEMPOTENCY_SECRET),
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
    validated.COMMERCE_ENABLED &&
    (!validated.COMMERCE_IDEMPOTENCY_SECRET || validated.COMMERCE_IDEMPOTENCY_SECRET.length < 32)
  ) {
    throw new Error(
      'COMMERCE_IDEMPOTENCY_SECRET must be at least 32 characters when Commerce is enabled',
    );
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

function isNodeEnvironment(value: string): value is NodeEnvironment {
  return value === 'development' || value === 'test' || value === 'production';
}
