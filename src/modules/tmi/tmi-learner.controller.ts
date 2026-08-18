import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ListTmiRewardsQueryDto } from './dto/list-tmi-rewards-query.dto';
import { TmiLedgerHistoryItem, TmiRedemptionService, TmiWalletResponse } from './tmi-redemption.service';

@ApiTags('TMI Learner')
@Controller('tmi')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
@ApiBearerAuth()
export class TmiLearnerController {
  constructor(private readonly service: TmiRedemptionService) {}

  @Get('rewards')
  @ApiOkResponse({ description: 'Active learner TMI rewards returned.' })
  listRewards(@Query() query: ListTmiRewardsQueryDto) {
    return this.service.listAvailableRewards(query);
  }

  @Get('wallet')
  @ApiOkResponse({ description: 'Server-derived learner TMI wallet returned.' })
  wallet(@CurrentUser('id') userId: string): Promise<TmiWalletResponse> {
    return this.service.wallet(userId);
  }

  @Get('history')
  @ApiOkResponse({ description: 'Sanitized learner TMI ledger history returned.' })
  history(@CurrentUser('id') userId: string): Promise<TmiLedgerHistoryItem[]> {
    return this.service.history(userId);
  }
}
