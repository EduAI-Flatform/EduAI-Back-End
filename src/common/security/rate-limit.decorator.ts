import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimitPolicy';

export interface RateLimitPolicy {
  identity: 'ip' | 'user';
  limit: number;
  modeOverrides?: Record<string, Pick<RateLimitPolicy, 'limit' | 'name' | 'windowSeconds'>>;
  name: string;
  onlyMultipart?: boolean;
  windowSeconds: number;
}

export const RateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(RATE_LIMIT_KEY, policy);

export const LoginRateLimit = () =>
  RateLimit({
    identity: 'ip',
    limit: 5,
    name: 'auth-login',
    windowSeconds: 15 * 60,
  });

export const FirebaseAuthRateLimit = () =>
  RateLimit({
    identity: 'ip',
    limit: 5,
    modeOverrides: {
      register: {
        limit: 10,
        name: 'auth-register',
        windowSeconds: 60 * 60,
      },
    },
    name: 'auth-firebase-login',
    windowSeconds: 15 * 60,
  });

export const UploadRateLimit = () =>
  RateLimit({
    identity: 'user',
    limit: 20,
    name: 'upload',
    onlyMultipart: true,
    windowSeconds: 24 * 60 * 60,
  });

export const UploadAuthorizationRateLimit = () =>
  RateLimit({
    identity: 'user',
    limit: 20,
    name: 'upload',
    windowSeconds: 24 * 60 * 60,
  });

export const PublicVerificationRateLimit = () =>
  RateLimit({
    identity: 'ip',
    limit: 60,
    name: 'public-verification',
    windowSeconds: 15 * 60,
  });
