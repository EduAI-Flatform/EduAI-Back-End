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
import { GdsBankCatalogueService } from './gds-bank-catalogue.service';
import { GdsBankLookupProvider } from './gds-bank-provider';
import { GdsAccountVerificationService } from './gds-account-verification.service';
import { GdsBankController, GdsBankAdminController, GdsBankLogoController } from './gds-bank.controller';

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule, PaymentsModule, AuditModule],
  controllers: [GdsWalletController, GdsWithdrawalController, GdsWithdrawalAdminController, GdsBankController, GdsBankAdminController, GdsBankLogoController],
  providers: [GdsWalletService, GdsInternalJournalService, GdsInternalSpendingService, GdsInternalTopupPreparationService, GdsInternalTopupLinkService, GdsPayosQrPreviewService, GdsInternalCheckoutService, GdsTopupCancellationService, GdsWithdrawalService, GdsRevenueWalletService, GdsBankCatalogueService, GdsBankLookupProvider, GdsAccountVerificationService],
})
export class GdsWalletModule {}
