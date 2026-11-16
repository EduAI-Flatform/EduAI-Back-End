import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_SESSION_TOKEN_VERSION } from './auth-session';

// Cache once per process. An old process must not read new build metadata from
// a deployment overwriting files and claim to be the replacement process.
function loadMetadata(): Readonly<{ tokenVersion: number; revision: string | null }> {
  try {
    const value = JSON.parse(readFileSync(join(process.cwd(), 'dist/auth-runtime.json'), 'utf8'));
    if (value.tokenVersion !== AUTH_SESSION_TOKEN_VERSION || !/^[0-9a-f]{40}$/.test(value.revision ?? '')) throw new Error();
    return Object.freeze({ tokenVersion: AUTH_SESSION_TOKEN_VERSION, revision: value.revision });
  } catch {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_RUNTIME_METADATA_INVALID');
    return Object.freeze({ tokenVersion: AUTH_SESSION_TOKEN_VERSION, revision: null });
  }
}
export const AUTH_RUNTIME_METADATA = loadMetadata();
