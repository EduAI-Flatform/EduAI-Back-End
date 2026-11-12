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
import { MembershipContinuityService } from './membership-continuity.service';
import { LegacyMembershipReportController } from './legacy-membership-report.controller';
import { LegacyMembershipReportService } from './legacy-membership-report.service';
import { LegacyMembershipInventoryService } from './legacy-membership-inventory.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, CommerceModule],
  controllers: [MembershipAdminController, ServiceEntitlementController, MembershipCheckoutController, LegacyMembershipReportController],
  providers: [MembershipAdminService, MembershipCheckoutService, MembershipContinuityService, ServiceEntitlementService, LegacyMembershipReportService, LegacyMembershipInventoryService],
  exports: [MembershipAdminService, MembershipContinuityService, ServiceEntitlementService],
})
export class MembershipsModule {}
