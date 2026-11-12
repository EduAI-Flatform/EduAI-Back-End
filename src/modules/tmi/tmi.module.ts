import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TmiRewardController } from './tmi-reward.controller';
import { TmiRedemptionController } from './tmi-redemption.controller';
import { TmiRewardService } from './tmi-reward.service';
import { TmiRedemptionService } from './tmi-redemption.service';
import { TmiLearnerController } from './tmi-learner.controller';
import { PointLedgerService } from './point-ledger.service';
import { ActivityPointService } from './activity-point.service';
import { ActivityPointWorker } from './activity-point.worker';
@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [TmiRewardController, TmiRedemptionController, TmiLearnerController],
  providers: [TmiRewardService, TmiRedemptionService, PointLedgerService, ActivityPointService, ActivityPointWorker],
  exports: [TmiRewardService, TmiRedemptionService],
})
export class TmiModule {}
