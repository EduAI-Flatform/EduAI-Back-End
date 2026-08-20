import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { StorageHealthService } from './storage-health.service';
import { FirebaseAdminModule } from '../firebase/firebase-admin.module';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseAdminModule, AiModule, AuthModule],
  controllers: [HealthController],
  providers: [HealthService, StorageHealthService],
})
export class HealthModule {}
