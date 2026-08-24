import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';
import { ServiceEntitlementController } from './service-entitlement.controller';
import { ServiceEntitlementService } from './service-entitlement.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [MembershipAdminController, ServiceEntitlementController],
  providers: [MembershipAdminService, ServiceEntitlementService],
  exports: [MembershipAdminService, ServiceEntitlementService],
})
export class MembershipsModule {}
