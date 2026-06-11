import { Module } from '@nestjs/common';
import { RedisModule } from './config/redis.module';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, RedisModule, HealthModule],
})
export class AppModule {}
