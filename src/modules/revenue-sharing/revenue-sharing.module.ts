import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';
import { RevenueAdminController, RevenueSellerController } from './revenue-sharing.controller';
import { RevenueSharingScheduler } from './revenue-sharing.scheduler';
@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RevenueAdminController, RevenueSellerController],
  providers: [RevenueFinanceService, RevenueMembershipService, RevenueSharingScheduler],
  exports: [RevenueFinanceService, RevenueMembershipService],
})
export class RevenueSharingModule {}