import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { RedisConfigService } from '../../../config/redis-config.service';
import {
  OAuthStateRecord,
  OAuthTicketRecord,
} from './oauth.types';

const CONSUME_SCRIPT =
  'local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); end; return value';

interface RedisTransactionClient {
  set(
    key: string,
    value: string,
    expirationMode: 'EX',
    ttl: string,
    condition: 'NX',
  ): Promise<unknown>;
  eval(script: string, numberOfKeys: number, key: string): Promise<unknown>;
}

interface MemoryEntry {
  expiresAt: number;
  value: string;
}

export class OAuthStateStoreError extends Error {
  constructor(
    public readonly code:
      | 'OAUTH_STATE_STORE_UNAVAILABLE'
      | 'OAUTH_STATE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthStateStoreError';
  }
}

@Injectable()
export class OAuthTransactionStore {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly redisConfig: RedisConfigService,
    private readonly appConfig: AppConfigService,
  ) {}

  setState(
    state: string,
    value: OAuthStateRecord,
    ttlSeconds: number,
  ): Promise<void> {
    return this.set('state', state, value, ttlSeconds);
  }

  consumeState(state: string): Promise<OAuthStateRecord | null> {
    return this.consume<OAuthStateRecord>('state', state);
  }

  setTicket(
    ticket: string,
    value: OAuthTicketRecord,
    ttlSeconds: number,
  ): Promise<void> {
    return this.set('ticket', ticket, value, ttlSeconds);
  }

  consumeTicket(ticket: string): Promise<OAuthTicketRecord | null> {
    return this.consume<OAuthTicketRecord>('ticket', ticket);
  }

  private async set<T>(
    kind: 'state' | 'ticket',
    valueKey: string,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    this.assertValueKey(valueKey);
    this.assertTtl(ttlSeconds);

    const key = this.buildKey(kind, valueKey);
    const serialized = JSON.stringify(value);
    const client = this.getRedisClient();

    if (client) {
      try {
        const result = await client.set(
          key,
          serialized,
          'EX',
          String(ttlSeconds),
          'NX',
        );
        if (result !== 'OK') {
          throw new OAuthStateStoreError(
            'OAUTH_STATE_STORE_UNAVAILABLE',
            'OAuth transaction key collision',
          );
        }
        return;
      } catch (error) {
        if (error instanceof OAuthStateStoreError) throw error;
        throw this.unavailableError();
      }
    }

    if (this.isProduction()) {
      throw this.unavailableError();
    }

    this.memory.set(key, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      value: serialized,
    });
  }

  private async consume<T>(
    kind: 'state' | 'ticket',
    valueKey: string,
  ): Promise<T | null> {
    this.assertValueKey(valueKey);

    const key = this.buildKey(kind, valueKey);
    const client = this.getRedisClient();

    if (client) {
      try {
        const raw = await client.eval(CONSUME_SCRIPT, 1, key);
        return raw === null || raw === undefined
          ? null
          : this.parse<T>(String(raw));
      } catch (error) {
        if (error instanceof OAuthStateStoreError) throw error;
        throw this.unavailableError();
      }
    }

    if (this.isProduction()) {
      throw this.unavailableError();
    }

    const entry = this.memory.get(key);
    this.memory.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return this.parse<T>(entry.value);
  }

  private parse<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new OAuthStateStoreError(
        'OAUTH_STATE_INVALID',
        'OAuth transaction data is invalid',
      );
    }
  }

  private getRedisClient(): RedisTransactionClient | undefined {
    try {
      return this.redisConfig.getClient() as RedisTransactionClient | undefined;
    } catch {
      throw this.unavailableError();
    }
  }

  private buildKey(kind: 'state' | 'ticket', value: string): string {
    const secret = this.appConfig.oauth.stateSecret;
    if (!secret) throw this.unavailableError();

    const digest = createHmac('sha256', secret)
      .update(value, 'utf8')
      .digest('hex');
    return `eduai:auth:oauth:${kind}:${digest}`;
  }

  private assertValueKey(value: string): void {
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(value)) {
      throw new OAuthStateStoreError(
        'OAUTH_STATE_INVALID',
        'OAuth transaction key is invalid',
      );
    }
  }

  private assertTtl(ttlSeconds: number): void {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
      throw new OAuthStateStoreError(
        'OAUTH_STATE_INVALID',
        'OAuth transaction TTL is invalid',
      );
    }
  }

  private isProduction(): boolean {
    return this.appConfig.app.nodeEnv === 'production';
  }

  private unavailableError(): OAuthStateStoreError {
    return new OAuthStateStoreError(
      'OAUTH_STATE_STORE_UNAVAILABLE',
      'OAuth transaction store is unavailable',
    );
  }
}
