import { Controller, Get } from '@nestjs/common';
import { RedisConfigService, RedisHealth } from '../../config/redis-config.service';

interface HealthResponse {
  status: 'ok';
  redis: RedisHealth;
}

@Controller('health')
export class HealthController {
  constructor(private readonly redisConfig: RedisConfigService) {}

  @Get()
  async getHealth(): Promise<HealthResponse> {
    const redis = await this.redisConfig.checkHealth();
    return { status: 'ok', redis };
  }
}
