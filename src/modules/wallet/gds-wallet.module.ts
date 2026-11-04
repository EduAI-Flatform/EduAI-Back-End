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
import { GdsInternalCheckoutService } from './gds-internal-checkout.service';
import { GdsTopupCancellationService } from './gds-topup-cancellation.service';
import { AuditModule } from '../../common/audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { GdsWithdrawalController, GdsWithdrawalAdminController } from './gds-withdrawal.controller';
import { GdsWithdrawalService } from './gds-withdrawal.service';
import { GdsRevenueWalletService } from './gds-revenue-wallet.service';

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule, PaymentsModule, AuditModule],
  controllers: [GdsWalletController, GdsWithdrawalController, GdsWithdrawalAdminController],
  providers: [GdsWalletService, GdsInternalJournalService, GdsInternalSpendingService, GdsInternalTopupPreparationService, GdsInternalTopupLinkService, GdsPayosQrPreviewService, GdsInternalCheckoutService, GdsTopupCancellationService, GdsWithdrawalService, GdsRevenueWalletService],
})
export class GdsWalletModule {}
