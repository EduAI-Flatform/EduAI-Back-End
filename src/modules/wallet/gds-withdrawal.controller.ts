import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GdsCreateWithdrawalDto, GdsRevenueReviewDto, GdsWithdrawalActionDto, GdsWithdrawalPageDto, GdsWithdrawalSettingsDto } from './dto/gds-withdrawal.dto';
import { GdsWithdrawalService } from './gds-withdrawal.service';
import { GdsRevenueWalletService } from './gds-revenue-wallet.service';

@ApiTags('GDS Withdrawals') @ApiBearerAuth()
@Controller('wallet/gds') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.student, RoleName.instructor)
@RateLimit({ identity: 'user', limit: 30, name: 'gds-withdrawal-user', windowSeconds: 60 })
export class GdsWithdrawalController {
  constructor(private readonly withdrawals: GdsWithdrawalService) {}
  @Get('withdrawal-settings') settings() { return this.withdrawals.settings(); }
  @Get('withdrawals') list(@CurrentUser('id') ownerId: string, @Query() query: GdsWithdrawalPageDto) { return this.withdrawals.list(query, ownerId); }
  @Get('withdrawals/:id') detail(@CurrentUser('id') ownerId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.withdrawals.detail(id, ownerId); }
  @Post('withdrawals') @RateLimit({ identity: 'user', limit: 5, name: 'gds-withdrawal-create', windowSeconds: 60 })
  create(@CurrentUser('id') ownerId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: GdsCreateWithdrawalDto) { return this.withdrawals.create(ownerId, input, key); }
  @Post('withdrawals/:id/cancel')
  cancel(@CurrentUser('id') ownerId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(ownerId, id, 'cancel', input, true); }
}

@ApiTags('Admin GDS Withdrawals') @ApiBearerAuth()
@Controller('admin/wallet/gds') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
@RateLimit({ identity: 'user', limit: 60, name: 'gds-withdrawal-admin', windowSeconds: 60 })
export class GdsWithdrawalAdminController {
  constructor(private readonly withdrawals: GdsWithdrawalService, private readonly revenue: GdsRevenueWalletService) {}
  @Get('withdrawal-settings') settings() { return this.withdrawals.settings(); }
  @Patch('withdrawal-settings') update(@CurrentUser('id') actor: string, @Body() input: GdsWithdrawalSettingsDto) { return this.withdrawals.updateSettings(actor, input); }
  @Get('withdrawals') list(@Query() query: GdsWithdrawalPageDto) { return this.withdrawals.list(query); }
  @Get('withdrawals/:id') detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.withdrawals.detail(id); }
  @Post('withdrawals/:id/approve') approve(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(actor, id, 'approve', input); }
  @Post('withdrawals/:id/reject') reject(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(actor, id, 'reject', input); }
  @Post('withdrawals/:id/process') process(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(actor, id, 'process', input); }
  @Post('withdrawals/:id/pay') pay(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(actor, id, 'pay', input); }
  @Post('withdrawals/:id/fail') fail(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsWithdrawalActionDto) { return this.withdrawals.act(actor, id, 'fail', input); }
  @Get('revenue-reviews') reviews(@Query() query: GdsWithdrawalPageDto) { return this.revenue.reviews(query); }
  @Post('revenue-reviews/:id/approve') review(@CurrentUser('id') actor: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: GdsRevenueReviewDto) { return this.revenue.approveReview(actor, id, input); }
}
