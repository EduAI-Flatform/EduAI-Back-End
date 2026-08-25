import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CommerceModule } from '../commerce/commerce.module';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';
import { MembershipCheckoutService } from './membership-checkout.service';
import { MembershipCheckoutController } from './membership-checkout.controller';
import { ServiceEntitlementController } from './service-entitlement.controller';
import { ServiceEntitlementService } from './service-entitlement.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, CommerceModule],
  controllers: [MembershipAdminController, ServiceEntitlementController, MembershipCheckoutController],
  providers: [MembershipAdminService, MembershipCheckoutService, ServiceEntitlementService],
  exports: [MembershipAdminService, ServiceEntitlementService],
})
export class MembershipsModule {}
