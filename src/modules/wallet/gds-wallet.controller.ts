import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GdsWalletService } from './gds-wallet.service';
import { GdsCreateTopupDto } from './dto/gds-create-topup.dto';
import { GdsPayosQrPreviewService } from './gds-payos-qr-preview.service';
import { GdsInternalCheckoutService } from './gds-internal-checkout.service';

@ApiTags('GDS Wallet (sandbox only)')
@ApiBearerAuth()
@Controller('wallet/gds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class GdsWalletController {
  constructor(
    private readonly wallet: GdsWalletService,
    private readonly qr: GdsPayosQrPreviewService,
    private readonly checkout: GdsInternalCheckoutService,
  ) {}

  @Get()
  @RateLimit({ identity: 'user', limit: 30, name: 'gds-wallet-summary', windowSeconds: 60 })
  summary(
    @CurrentUser('id') buyerId: string,
    @Query('topupId', new ParseUUIDPipe({ version: '4', optional: true })) topupId?: string,
  ) {
    return this.wallet.summary(buyerId, topupId);
  }

  @Post('topups/payos')
  @RateLimit({ identity: 'user', limit: 2, name: 'gds-payos-qr-preview', windowSeconds: 60 })
  createPayosQr(
    @CurrentUser('id') buyerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: GdsCreateTopupDto,
  ) {
    return this.qr.create(buyerId, input.amountMinor, idempotencyKey);
  }

  /** One order = one idempotency identity. UAT only; no browser payment proof. */
  @Post('orders/:orderId/pay')
  @RateLimit({ identity: 'user', limit: 5, name: 'gds-wallet-checkout', windowSeconds: 60 })
  payOrder(
    @CurrentUser('id') buyerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ) {
    return this.checkout.payOrder(buyerId, orderId);
  }
}
