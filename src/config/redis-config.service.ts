import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { AppConfigService } from './app-config.service';

export type RedisHealthStatus = 'ok' | 'disabled' | 'error';

export interface RedisHealth {
  status: RedisHealthStatus;
}

@Injectable()
export class RedisConfigService implements OnModuleDestroy {
  private readonly redisUrl?: string;
  private client?: Redis;

  constructor(appConfig: AppConfigService) {
    this.redisUrl = appConfig.redis.url;
  }

  getRedisUrl(): string | undefined {
    return this.redisUrl;
  }

  isEnabled(): boolean {
    return Boolean(this.redisUrl);
  }

  getClient(): Redis | undefined {
    if (!this.redisUrl) {
      return undefined;
    }

    this.client ??= new Redis(this.redisUrl, this.getClientOptions());
    return this.client;
  }

  async checkHealth(): Promise<RedisHealth> {
    const client = this.getClient();

    if (!client) {
      return { status: 'disabled' };
    }

    try {
      await client.ping();
      return { status: 'ok' };
    } catch {
      return { status: 'error' };
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }

  private getClientOptions(): RedisOptions {
    return {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    };
  }
}
