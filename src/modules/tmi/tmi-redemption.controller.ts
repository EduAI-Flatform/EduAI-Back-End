import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdjustTmiBalanceDto } from './dto/adjust-tmi-balance.dto';
import { ListTmiAdminLedgerQueryDto } from './dto/list-tmi-admin-ledger-query.dto';
import { ListTmiAdminRedemptionsQueryDto } from './dto/list-tmi-admin-redemptions-query.dto';
import { RedeemTmiRewardDto } from './dto/redeem-tmi-reward.dto';
import { RefundTmiRedemptionDto } from './dto/refund-tmi-redemption.dto';
import { TmiAdminLedgerPage, TmiAdminRedemptionPage, TmiBalanceAdjustmentResponse, TmiRedemptionResponse, TmiRefundResponse, TmiRedemptionService } from './tmi-redemption.service';

@ApiTags('TMI Redemption')
@Controller()
export class TmiRedemptionController {
  constructor(private readonly service: TmiRedemptionService) {}

  @Get('admin/tmi/redemptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  listAdminRedemptions(@Query() query: ListTmiAdminRedemptionsQueryDto): Promise<TmiAdminRedemptionPage> {
    return this.service.listAdminRedemptions(query);
  }

  @Get('admin/tmi/ledger')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  listAdminLedger(@Query() query: ListTmiAdminLedgerQueryDto): Promise<TmiAdminLedgerPage> {
    return this.service.listAdminLedger(query);
  }

  @Post('tmi/rewards/:rewardId/redemptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'TMI reward redeemed successfully.' })
  redeem(
    @CurrentUser('id') userId: string,
    @Param('rewardId', new ParseUUIDPipe({ version: '4' })) rewardId: string,
    @Body() input: RedeemTmiRewardDto,
  ): Promise<TmiRedemptionResponse> {
    return this.service.redeem(userId, rewardId, input);
  }

  @Post('admin/tmi/redemptions/:redemptionId/refund')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'TMI redemption refunded successfully.' })
  refund(
    @CurrentUser('id') actorId: string,
    @Param('redemptionId', new ParseUUIDPipe({ version: '4' })) redemptionId: string,
    @Body() input: RefundTmiRedemptionDto,
  ): Promise<TmiRefundResponse> {
    return this.service.refund(actorId, redemptionId, input);
  }

  @Post('admin/tmi/adjustments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'TMI balance adjustment recorded successfully.' })
  adjustBalance(
    @CurrentUser('id') actorId: string,
    @Body() input: AdjustTmiBalanceDto,
  ): Promise<TmiBalanceAdjustmentResponse> {
    return this.service.adjustBalance(actorId, input);
  }
}
