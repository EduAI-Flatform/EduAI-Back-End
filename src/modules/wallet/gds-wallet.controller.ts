import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
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
import { GdsTopupCancellationService } from './gds-topup-cancellation.service';
import { parseHistoryQuery } from './gds-wallet-history';

@ApiTags('GDS Wallet')
@ApiBearerAuth()
@Controller('wallet/gds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student, RoleName.instructor)
export class GdsWalletController {
  constructor(
    private readonly wallet: GdsWalletService,
    private readonly qr: GdsPayosQrPreviewService,
    private readonly checkout: GdsInternalCheckoutService,
    private readonly cancellation: GdsTopupCancellationService,
  ) {}

  @Get()
  @ApiQuery({ name: 'topupId', required: false, schema: { type: 'string', format: 'uuid' } })
  @RateLimit({ identity: 'user', limit: 30, name: 'gds-wallet-summary', windowSeconds: 60 })
  summary(
    @CurrentUser('id') buyerId: string,
    @Query('topupId', new ParseUUIDPipe({ version: '4', optional: true })) topupId?: string,
    @CurrentUser('roles') roles?: RoleName[],
  ) {
    return this.wallet.summary(buyerId, topupId, roles);
  }

  @Get('transactions')
  @ApiQuery({ name: 'filter', required: false, enum: ['all','incoming','outgoing','payments','withdrawals'] })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 512 } })
  @RateLimit({ identity: 'user', limit: 30, name: 'gds-wallet-history', windowSeconds: 60 })
  transactions(@CurrentUser('id') ownerId: string, @Query('filter') filter?: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.wallet.transactions(ownerId, parseHistoryQuery(ownerId, filter, limit, cursor));
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

  /** Cancels only an authenticated, unpaid link owned by the learner. */
  @Post('topups/:topupId/cancel')
  @RateLimit({ identity: 'user', limit: 5, name: 'gds-topup-cancel', windowSeconds: 60 })
  cancelTopup(
    @CurrentUser('id') buyerId: string,
    @Param('topupId', new ParseUUIDPipe({ version: '4' })) topupId: string,
  ) {
    return this.cancellation.cancel(buyerId, topupId);
  }

  /** One order = one idempotency identity. No browser payment proof. */
  @Post('orders/:orderId/pay')
  @Roles(RoleName.student)
  @RateLimit({ identity: 'user', limit: 5, name: 'gds-wallet-checkout', windowSeconds: 60 })
  payOrder(
    @CurrentUser('id') buyerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ) {
    return this.checkout.payOrder(buyerId, orderId);
  }
}
