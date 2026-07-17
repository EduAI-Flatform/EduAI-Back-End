import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisConfigService } from '../../config/redis-config.service';

const DAILY_LIMIT = 30;
const localUsage = new Map<string, number>();

@Injectable()
export class AiRateLimitService {
  constructor(private readonly redisConfig: RedisConfigService) {}

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

  private async assertAllowed(userId: string, operation: string): Promise<void> {
    const key = `ai:${operation}:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const redis = this.redisConfig.getClient();

    if (!redis) {
      const nextUsage = (localUsage.get(key) ?? 0) + 1;
      localUsage.set(key, nextUsage);
      if (nextUsage > DAILY_LIMIT) {
        throw new HttpException('Daily AI chat limit reached', HttpStatus.TOO_MANY_REQUESTS);
      }
      return;
    }

    try {
      const usage = await redis.incr(key);
      if (usage === 1) {
        const secondsUntilReset = Math.max(
          1,
          Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000),
        );
        await redis.expire(key, secondsUntilReset);
      }
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
