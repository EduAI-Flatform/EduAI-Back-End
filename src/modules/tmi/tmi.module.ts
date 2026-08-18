import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TmiRewardController } from './tmi-reward.controller';
import { TmiRedemptionController } from './tmi-redemption.controller';
import { TmiRewardService } from './tmi-reward.service';
import { TmiRedemptionService } from './tmi-redemption.service';
@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [TmiRewardController, TmiRedemptionController],
  providers: [TmiRewardService, TmiRedemptionService],
  exports: [TmiRewardService, TmiRedemptionService],
})
export class TmiModule {}
