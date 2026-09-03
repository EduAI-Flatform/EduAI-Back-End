import { AppConfigService } from '../../../config/app-config.service';
import { RedisConfigService } from '../../../config/redis-config.service';
import { OAuthStateRecord } from './oauth.types';
import { OAuthTransactionStore } from './oauth-transaction.store';

describe('OAuthTransactionStore', () => {
  const appConfig = {
    app: { nodeEnv: 'test' },
    oauth: {
      stateSecret: 's'.repeat(32),
    },
  } as AppConfigService;
  const state: OAuthStateRecord = {
    provider: 'facebook',
    mode: 'login',
    redirectTo: '/',
    createdAt: Date.now(),
  };

  it('consumes an in-memory state exactly once in test mode', async () => {
    const store = new OAuthTransactionStore(
      { getClient: () => undefined } as RedisConfigService,
      appConfig,
    );

    const stateKey = 'state-value-abcdefghijklmnopqrstuvwxyz';
    await store.setState(stateKey, state, 60);

    await expect(store.consumeState(stateKey)).resolves.toEqual(state);
    await expect(store.consumeState(stateKey)).resolves.toBeNull();
  });

  it('expires in-memory state without returning stale transactions', async () => {
    jest.useFakeTimers();
    try {
      const store = new OAuthTransactionStore(
        { getClient: () => undefined } as RedisConfigService,
        appConfig,
      );

      const stateKey = 'expiring-state-abcdefghijklmnopqrstuvw';
      await store.setState(stateKey, state, 60);
      jest.advanceTimersByTime(60_001);

      await expect(store.consumeState(stateKey)).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed in production when Redis is unavailable', async () => {
    const store = new OAuthTransactionStore(
      { getClient: () => undefined } as RedisConfigService,
      {
        app: { nodeEnv: 'production' },
        oauth: { stateSecret: 's'.repeat(32) },
      } as AppConfigService,
    );

    await expect(
      store.setState('state-value-abcdefghijklmnopqrstuvwxyz', state, 60),
    ).rejects.toMatchObject({
      code: 'OAUTH_STATE_STORE_UNAVAILABLE',
    });
  });

  it('uses a server-side Redis key and atomic GET+DEL for replay protection', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(JSON.stringify(state)),
    };
    const store = new OAuthTransactionStore(
      { getClient: () => redis } as unknown as RedisConfigService,
      appConfig,
    );

    const stateKey = 'state-value-abcdefghijklmnopqrstuvwxyz';
    await store.setState(stateKey, state, 60);
    await expect(store.consumeState(stateKey)).resolves.toEqual(state);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^eduai:auth:oauth:state:/),
      JSON.stringify(state),
      'EX',
      '60',
      'NX',
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET"'),
      1,
      expect.stringMatching(/^eduai:auth:oauth:state:/),
    );
  });
});
