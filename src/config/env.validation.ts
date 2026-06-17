export type NodeEnvironment = 'development' | 'test' | 'production';

export interface ValidatedEnv {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL?: string;
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_PUBLIC_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export function loadBackendEnv(): ValidatedEnv {
  return validateEnv(process.env);
}

export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const nodeEnv = optionalString(config.NODE_ENV) ?? 'development';

  if (!isNodeEnvironment(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const validated: ValidatedEnv = {
    NODE_ENV: nodeEnv,
    PORT: parsePort(config.PORT),
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
    R2_ACCOUNT_ID: optionalString(config.R2_ACCOUNT_ID),
    R2_ACCESS_KEY_ID: optionalString(config.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: optionalString(config.R2_SECRET_ACCESS_KEY),
    R2_BUCKET_NAME: optionalString(config.R2_BUCKET_NAME),
    R2_PUBLIC_URL: optionalString(config.R2_PUBLIC_URL),
    OPENAI_API_KEY: optionalString(config.OPENAI_API_KEY),
    OPENAI_MODEL: optionalString(config.OPENAI_MODEL),
  };

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

function isNodeEnvironment(value: string): value is NodeEnvironment {
  return value === 'development' || value === 'test' || value === 'production';
}
