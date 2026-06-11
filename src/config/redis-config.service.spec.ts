import { RedisConfigService } from './redis-config.service';
import { AppConfigService } from './app-config.service';

describe('RedisConfigService', () => {
  it('is disabled when REDIS_URL is missing', async () => {
    const service = new RedisConfigService(createConfigService());

    expect(service.getRedisUrl()).toBeUndefined();
    expect(service.isEnabled()).toBe(false);
    expect(service.getClient()).toBeUndefined();
    await expect(service.checkHealth()).resolves.toEqual({ status: 'disabled' });
  });

  it('loads REDIS_URL from env and creates a client lazily', async () => {
    const service = new RedisConfigService(createConfigService('redis://localhost:6379'));

    const client = service.getClient();

    expect(service.getRedisUrl()).toBe('redis://localhost:6379');
    expect(service.isEnabled()).toBe(true);
    expect(client).toBeDefined();

    await service.onModuleDestroy();
  });
});

function createConfigService(redisUrl?: string): AppConfigService {
  return {
    redis: {
      url: redisUrl,
    },
  } as AppConfigService;
}
