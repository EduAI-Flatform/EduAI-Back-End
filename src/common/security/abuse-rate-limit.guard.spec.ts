import { ExecutionContext, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../../config/app-config.service';
import { RedisConfigService } from '../../config/redis-config.service';
import { AbuseRateLimitGuard } from './abuse-rate-limit.guard';
import { RATE_LIMIT_KEY, RateLimitPolicy } from './rate-limit.decorator';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function createGuard(
  policy?: RateLimitPolicy,
  redis?: Record<string, jest.Mock>,
  nodeEnv: 'development' | 'production' = 'development',
) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === RATE_LIMIT_KEY ? policy : undefined,
    ),
  } as unknown as Reflector;
  const redisConfig = {
    getClient: jest.fn().mockReturnValue(redis),
  } as unknown as RedisConfigService;
  const appConfig = { app: { nodeEnv } } as AppConfigService;

  return new AbuseRateLimitGuard(reflector, redisConfig, appConfig);
}

describe('AbuseRateLimitGuard', () => {
  const loginPolicy: RateLimitPolicy = {
    identity: 'ip',
    limit: 2,
    name: 'auth-login',
    windowSeconds: 900,
  };

  it('does nothing when an endpoint has no rate-limit policy', async () => {
    await expect(createGuard().canActivate(context({}))).resolves.toBe(true);
  });

  it('rejects usage above the configured local fallback limit', async () => {
    const guard = createGuard(loginPolicy);
    const request = { ip: '203.0.113.8', headers: {}, socket: {} };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('uses a hashed identity in Redis and sets a bounded expiry', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
    };
    const guard = createGuard(loginPolicy, redis);

    await expect(
      guard.canActivate(
        context({ ip: '203.0.113.8', headers: {}, socket: {} }),
      ),
    ).resolves.toBe(true);

    const key = redis.eval.mock.calls[0][2] as string;
    expect(key).not.toContain('203.0.113.8');
    expect(key).toMatch(/^security-rate:auth-login:[a-f0-9]{64}:\d+$/);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, key, 901);
  });

  it('selects the registration window from the validated request mode', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const guard = createGuard(
      {
        ...loginPolicy,
        modeOverrides: {
          register: { limit: 10, name: 'auth-register', windowSeconds: 3600 },
        },
      },
      redis,
    );

    await guard.canActivate(
      context({ body: { mode: 'register' }, headers: {}, ip: '203.0.113.8', socket: {} }),
    );

    expect(redis.eval.mock.calls[0][2]).toMatch(
      /^security-rate:auth-register:[a-f0-9]{64}:\d+$/,
    );
    expect(redis.eval.mock.calls[0][3]).toBe(3601);
  });

  it('fails closed when the configured Redis limiter is unavailable', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };

    await expect(
      createGuard(loginPolicy, redis).canActivate(
        context({ ip: '203.0.113.8', headers: {}, socket: {} }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed in production when Redis is not configured', async () => {
    await expect(
      createGuard(loginPolicy, undefined, 'production').canActivate(
        context({ ip: '203.0.113.8', headers: {}, socket: {} }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not count a JSON request against a multipart upload policy', async () => {
    const guard = createGuard({ ...loginPolicy, onlyMultipart: true });

    await expect(
      guard.canActivate(context({ headers: { 'content-type': 'application/json' } })),
    ).resolves.toBe(true);
  });
});
