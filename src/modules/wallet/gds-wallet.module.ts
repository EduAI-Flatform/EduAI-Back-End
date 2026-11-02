import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { GdsWalletController } from './gds-wallet.controller';
import { GdsWalletService } from './gds-wallet.service';
import { GdsInternalJournalService } from './gds-internal-journal.service';
import { GdsInternalSpendingService } from './gds-internal-spending.service';
import { GdsInternalTopupPreparationService } from './gds-internal-topup-preparation.service';
import { GdsInternalTopupLinkService } from './gds-internal-topup-link.service';

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule],
  controllers: [GdsWalletController],
  providers: [GdsWalletService, GdsInternalJournalService, GdsInternalSpendingService, GdsInternalTopupPreparationService, GdsInternalTopupLinkService],
})
export class GdsWalletModule {}
