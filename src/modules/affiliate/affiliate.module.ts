import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AppConfigModule } from '../../config/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { AffiliateController } from './affiliate.controller';
import { AffiliateService } from './affiliate.service';
import { GdsWalletModule } from '../wallet/gds-wallet.module';
@Module({ imports: [PrismaModule, AuthModule, PlatformModule, AppConfigModule, GdsWalletModule], controllers: [AffiliateController], providers: [AffiliateService] })
export class AffiliateModule {}
