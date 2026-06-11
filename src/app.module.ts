import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { RedisModule } from './config/redis.module';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule, RedisModule, HealthModule],
})
export class AppModule {}
