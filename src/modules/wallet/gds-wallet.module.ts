import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { GdsWalletController } from './gds-wallet.controller';
import { GdsWalletService } from './gds-wallet.service';

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule],
  controllers: [GdsWalletController],
  providers: [GdsWalletService],
})
export class GdsWalletModule {}
