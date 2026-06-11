import { RedisConfigService } from './redis-config.service';

describe('RedisConfigService', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
      return;
    }

    process.env.REDIS_URL = originalRedisUrl;
  });

  it('is disabled when REDIS_URL is missing', async () => {
    delete process.env.REDIS_URL;

    const service = new RedisConfigService();

    expect(service.getRedisUrl()).toBeUndefined();
    expect(service.isEnabled()).toBe(false);
    expect(service.getClient()).toBeUndefined();
    await expect(service.checkHealth()).resolves.toEqual({ status: 'disabled' });
  });

  it('loads REDIS_URL from env and creates a client lazily', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const service = new RedisConfigService();

    const client = service.getClient();

    expect(service.getRedisUrl()).toBe('redis://localhost:6379');
    expect(service.isEnabled()).toBe(true);
    expect(client).toBeDefined();

    await service.onModuleDestroy();
  });
});
