import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { RedisConfigService } from '../../config/redis-config.service';
import { AppConfigService } from '../../config/app-config.service';
import { RATE_LIMIT_KEY, RateLimitPolicy } from './rate-limit.decorator';

interface RateLimitedRequest extends Request {
  user?: { id?: string };
}

interface LocalUsage {
  count: number;
  expiresAt: number;
}

@Injectable()
export class AbuseRateLimitGuard implements CanActivate {
  private readonly localUsage = new Map<string, LocalUsage>();

  constructor(
    private readonly reflector: Reflector,
    private readonly redisConfig: RedisConfigService,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policy) return true;

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const mode = this.getBodyMode(request);
    const override = mode ? policy.modeOverrides?.[mode] : undefined;
    const effectivePolicy = override ? { ...policy, ...override } : policy;
    if (
      effectivePolicy.onlyMultipart &&
      !request.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')
    ) {
      return true;
    }
    const identity = this.resolveIdentity(request, effectivePolicy);
    const bucket = Math.floor(Date.now() / (effectivePolicy.windowSeconds * 1000));
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const key = `security-rate:${effectivePolicy.name}:${identityHash}:${bucket}`;
    const redis = this.redisConfig.getClient();

    if (!redis) {
      if (this.appConfig.app.nodeEnv === 'production') {
        throw new ServiceUnavailableException('Rate limit service is unavailable');
      }
      this.assertLocalAllowed(key, effectivePolicy);
      return true;
    }

    try {
      const usage = Number(await redis.eval(
        "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return current",
        1,
        key,
        effectivePolicy.windowSeconds + 1,
      ));
      this.assertWithinLimit(usage, effectivePolicy.limit);
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Rate limit service is unavailable');
    }
  }

  private getBodyMode(request: RateLimitedRequest): string | undefined {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const mode = (body as Record<string, unknown>).mode;
    return typeof mode === 'string' ? mode : undefined;
  }

  private resolveIdentity(
    request: RateLimitedRequest,
    policy: RateLimitPolicy,
  ): string {
    if (policy.identity === 'user') {
      if (!request.user?.id) throw new UnauthorizedException('Authentication required');
      return `user:${request.user.id}`;
    }

    return `ip:${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`;
  }

  private assertLocalAllowed(key: string, policy: RateLimitPolicy): void {
    const now = Date.now();
    const current = this.localUsage.get(key);
    const usage = !current || current.expiresAt <= now
      ? { count: 1, expiresAt: now + policy.windowSeconds * 1000 }
      : { ...current, count: current.count + 1 };
    this.localUsage.set(key, usage);
    this.assertWithinLimit(usage.count, policy.limit);
  }

  private assertWithinLimit(usage: number, limit: number): void {
    if (usage > limit) {
      throw new HttpException('Request rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
