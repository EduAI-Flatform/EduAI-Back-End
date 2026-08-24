import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [MembershipAdminController],
  providers: [MembershipAdminService],
  exports: [MembershipAdminService],
})
export class MembershipsModule {}
