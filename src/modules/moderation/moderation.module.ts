import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import {
  AdminModerationController,
  ModerationController,
} from './moderation.controller';
import { ModerationService } from './moderation.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminModerationController, ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
