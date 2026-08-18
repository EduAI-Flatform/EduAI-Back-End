import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TmiRewardController } from './tmi-reward.controller';
import { TmiRewardService } from './tmi-reward.service';
@Module({ imports: [PrismaModule, AuthModule, AuditModule], controllers: [TmiRewardController], providers: [TmiRewardService], exports: [TmiRewardService] })
export class TmiModule {}
