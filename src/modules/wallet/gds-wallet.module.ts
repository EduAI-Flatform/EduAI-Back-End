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
import { GdsPayosQrPreviewService } from './gds-payos-qr-preview.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule, PaymentsModule],
  controllers: [GdsWalletController],
  providers: [GdsWalletService, GdsInternalJournalService, GdsInternalSpendingService, GdsInternalTopupPreparationService, GdsInternalTopupLinkService, GdsPayosQrPreviewService],
})
export class GdsWalletModule {}
