export type NodeEnvironment = 'development' | 'test' | 'production';
export type AiProviderName = 'gemini' | 'openai' | 'mock';

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
  };

  if (validated.NODE_ENV === 'production' && validated.AI_PROVIDER === 'mock') {
    throw new Error('AI_PROVIDER=mock is not allowed in production');
  }

  return validated;
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
