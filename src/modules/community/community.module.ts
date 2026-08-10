import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [CommunityController],
  providers: [CommunityService],
})
export class CommunityModule {}
