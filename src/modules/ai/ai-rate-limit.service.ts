import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisConfigService } from '../../config/redis-config.service';
import { AppConfigService } from '../../config/app-config.service';

const DAILY_LIMIT = 30;
@Injectable()
export class AiRateLimitService {
  private readonly localUsage = new Map<string, number>();

  constructor(
    private readonly redisConfig: RedisConfigService,
    private readonly appConfig: AppConfigService,
  ) {}

  async assertChatAllowed(userId: string): Promise<void> {
    return this.assertAllowed(userId, 'chat');
  }

  async assertSummaryAllowed(userId: string): Promise<void> {
    return this.assertAllowed(userId, 'summary');
  }

  async assertQuizAllowed(userId: string): Promise<void> {
    return this.assertAllowed(userId, 'quiz');
  }

  async assertFlashcardsAllowed(userId: string): Promise<void> {
    return this.assertAllowed(userId, 'flashcards');
  }

  async assertLearningPathAllowed(userId: string): Promise<void> {
    return this.assertAllowed(userId, 'learning-path');
  }

  private async assertAllowed(userId: string, operation: string): Promise<void> {
    const userHash = createHash('sha256').update(userId).digest('hex');
    const key = `ai:${operation}:${userHash}:${new Date().toISOString().slice(0, 10)}`;
    const redis = this.redisConfig.getClient();

    if (!redis) {
      if (this.appConfig.app.nodeEnv === 'production') {
        throw new ServiceUnavailableException('AI quota service is unavailable');
      }
      const nextUsage = (this.localUsage.get(key) ?? 0) + 1;
      this.localUsage.set(key, nextUsage);
      if (nextUsage > DAILY_LIMIT) {
        throw new HttpException('Daily AI chat limit reached', HttpStatus.TOO_MANY_REQUESTS);
      }
      return;
    }

    try {
      const secondsUntilReset = Math.max(
        1,
        Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000),
      );
      const usage = Number(await redis.eval(
        "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return current",
        1,
        key,
        secondsUntilReset,
      ));
      if (usage > DAILY_LIMIT) {
        throw new HttpException('Daily AI chat limit reached', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        throw error;
      }
      throw new ServiceUnavailableException('AI quota service is unavailable');
    }
  }
}
