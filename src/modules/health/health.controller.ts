import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RedisConfigService, RedisHealth } from '../../config/redis-config.service';
import { Public } from '../../common/security/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DependencyHealthResponse, HealthService } from './health.service';
import { AUTH_RUNTIME_METADATA } from '../auth/auth-runtime-metadata';

interface HealthResponse {
  status: 'ok';
  redis: RedisHealth;
  authSession: typeof AUTH_RUNTIME_METADATA;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly redisConfig: RedisConfigService,
    private readonly health: HealthService,
  ) {}

  @Get()
  @Public()
  async getHealth(): Promise<HealthResponse> {
    const redis = await this.redisConfig.checkHealth();
    return { status: 'ok', redis, authSession: AUTH_RUNTIME_METADATA };
  }

  @Get('dependencies')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  getDependencies(): Promise<DependencyHealthResponse> {
    return this.health.checkDependencies();
  }
}
