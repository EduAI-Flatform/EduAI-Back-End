import { HttpException } from '@nestjs/common';
import { OAuthProviderError } from './oauth-provider.service';

const SAFE_OAUTH_CODES = new Set([
  'ACCOUNT_ALREADY_EXISTS',
  'ACCOUNT_LINK_CONFLICT',
  'ACCOUNT_ROLE_REQUIRED',
  'OAUTH_CALLBACK_FAILED',
  'OAUTH_MODE_INVALID',
  'OAUTH_PROVIDER_CANCELLED',
  'OAUTH_PROVIDER_MISMATCH',
  'OAUTH_PROVIDER_REQUEST_FAILED',
  'OAUTH_PROVIDER_RESPONSE_INVALID',
  'OAUTH_PROVIDER_UNAVAILABLE',
  'OAUTH_PROVIDER_UNSUPPORTED',
  'OAUTH_REDIRECT_NOT_ALLOWED',
  'OAUTH_ROLE_MISMATCH',
  'OAUTH_ROLE_NOT_ALLOWED',
  'OAUTH_PROFILE_REQUIRED',
  'OAUTH_STATE_INVALID',
  'OAUTH_STATE_STORE_UNAVAILABLE',
  'OAUTH_TICKET_INVALID',
  'SOCIAL_ACCOUNT_LINK_REQUIRED',
]);

const SAFE_PRISMA_CODES = new Set(['P2002', 'P2003', 'P2021', 'P2022']);

export function isSafeOAuthCode(value: string): boolean {
  return SAFE_OAUTH_CODES.has(value);
}

export function buildOAuthDiagnosticMetadata(
  provider: string,
  stage: string,
  error: unknown,
  correlationId?: string,
): Record<string, string> {
  const metadata: Record<string, string> = {
    exceptionClass: sanitizeClass(getExceptionClass(error)),
    provider: provider === 'facebook' || provider === 'zalo' ? provider : 'unknown',
    safeOAuthCode: getSafeOAuthCode(error),
    stage: sanitizeValue(stage, 48),
  };

  const prismaCode = getPrismaCode(error);
  if (prismaCode) metadata.prismaCode = prismaCode;

  const targetField = getPrismaTargetField(error);
  if (targetField) metadata.targetField = targetField;

  const driverAdapter = getDriverAdapterMetadata(error);
  if (driverAdapter.kind) metadata.driverAdapterKind = driverAdapter.kind;
  if (driverAdapter.code) metadata.driverAdapterCode = driverAdapter.code;

  if (correlationId && /^[A-Za-z0-9._:-]{8,64}$/.test(correlationId)) {
    metadata.correlationId = correlationId;
  }

  return metadata;
}

function getSafeOAuthCode(error: unknown): string {
  if (error instanceof OAuthProviderError && SAFE_OAUTH_CODES.has(error.code)) {
    return error.code;
  }

  const code = readStringProperty(error, 'code');
  if (code && SAFE_OAUTH_CODES.has(code)) return code;

  if (error instanceof HttpException) {
    const response = error.getResponse();
    const responseCode = readStringProperty(response, 'error');
    if (responseCode && SAFE_OAUTH_CODES.has(responseCode)) return responseCode;
  }

  return 'OAUTH_CALLBACK_FAILED';
}

function getPrismaCode(error: unknown): string | undefined {
  const code = readStringProperty(error, 'code');
  return code && SAFE_PRISMA_CODES.has(code) ? code : undefined;
}

function getPrismaTargetField(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.meta)) return undefined;

  const target = error.meta.target;
  const values = Array.isArray(target)
    ? target.filter((value): value is string => typeof value === 'string')
    : typeof target === 'string'
      ? [target]
      : [];
  const safeValues = values.filter((value) =>
    /^[A-Za-z0-9_.-]{1,64}$/.test(value),
  );

  return safeValues.length > 0 ? safeValues.join(',').slice(0, 128) : undefined;
}

function getDriverAdapterMetadata(error: unknown): {
  kind?: string;
  code?: string;
} {
  if (!isRecord(error) || error.name !== 'DriverAdapterError') {
    return {};
  }
  if (!isRecord(error.cause)) return {};

  const kind = readStringProperty(error.cause, 'kind');
  const originalCode = readStringProperty(error.cause, 'originalCode');
  const code = readStringProperty(error.cause, 'code');
  return {
    ...(kind ? { kind: sanitizeValue(kind, 64) } : {}),
    ...((originalCode ?? code) && /^[A-Za-z0-9._-]{1,32}$/.test(originalCode ?? code ?? '')
      ? { code: originalCode ?? code }
      : {}),
  };
}

function getExceptionClass(error: unknown): string {
  if (error instanceof Error && error.constructor.name) {
    return error.constructor.name;
  }
  return typeof error;
}

function sanitizeClass(value: string): string {
  return sanitizeValue(value, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function sanitizeValue(value: string, maxLength: number): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, maxLength);
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== 'string') return undefined;
  return value[key] as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
