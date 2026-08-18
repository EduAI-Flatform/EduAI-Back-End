import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateTmiRewardDto } from './dto/create-tmi-reward.dto';
import { ListTmiRewardsQueryDto } from './dto/list-tmi-rewards-query.dto';
import { UpdateTmiRewardDto } from './dto/update-tmi-reward.dto';
import { TmiRewardPage, TmiRewardResponse, TmiRewardService } from './tmi-reward.service';

@ApiTags('TMI Rewards')
@Controller('admin/tmi/rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
@ApiBearerAuth()
export class TmiRewardController {
  constructor(private readonly service: TmiRewardService) {}
  @Post() @ApiCreatedResponse() create(@CurrentUser('id') actorId: string, @Body() input: CreateTmiRewardDto): Promise<TmiRewardResponse> { return this.service.create(actorId, input); }
  @Get() @ApiOkResponse() list(@Query() query: ListTmiRewardsQueryDto): Promise<TmiRewardPage> { return this.service.list(query); }
  @Get(':id') @ApiOkResponse() get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<TmiRewardResponse> { return this.service.get(id); }
  @Patch(':id') @ApiOkResponse() update(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: UpdateTmiRewardDto): Promise<TmiRewardResponse> { return this.service.update(actorId, id, input); }
}
