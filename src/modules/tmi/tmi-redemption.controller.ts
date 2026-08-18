import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdjustTmiBalanceDto } from './dto/adjust-tmi-balance.dto';
import { RedeemTmiRewardDto } from './dto/redeem-tmi-reward.dto';
import { RefundTmiRedemptionDto } from './dto/refund-tmi-redemption.dto';
import { TmiBalanceAdjustmentResponse, TmiRedemptionResponse, TmiRefundResponse, TmiRedemptionService } from './tmi-redemption.service';

@ApiTags('TMI Redemption')
@Controller()
export class TmiRedemptionController {
  constructor(private readonly service: TmiRedemptionService) {}

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
