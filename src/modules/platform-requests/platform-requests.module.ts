import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { AdminPlatformRequestsController, PlatformSupportController, PublicPartnerApplicationsController } from './platform-requests.controller';
import { PlatformRequestsService } from './platform-requests.service';

@Module({ imports: [PrismaModule, AuthModule, PlatformModule],
  controllers: [PlatformSupportController, PublicPartnerApplicationsController, AdminPlatformRequestsController],
  providers: [PlatformRequestsService], exports: [PlatformRequestsService] })
export class PlatformRequestsModule {}
