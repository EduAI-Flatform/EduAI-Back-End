import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CreateMembershipPlanDto,
  CreateMembershipPlanVersionDto,
  ListMembershipPlansQueryDto,
} from './dto/membership-plan.dto';
import { MembershipAdminService } from './membership-admin.service';

@ApiTags('Admin Membership')
@ApiBearerAuth()
@Controller('admin/membership')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class MembershipAdminController {
  constructor(private readonly service: MembershipAdminService) {}

  @Post('plans')
  @ApiCreatedResponse({ description: 'Stable membership plan and first draft version created.' })
  createPlan(@CurrentUser('id') actorId: string, @Body() input: CreateMembershipPlanDto) {
    return this.service.createPlan(actorId, input);
  }

  @Get('plans')
  @ApiOkResponse({ description: 'Paginated membership plans and immutable version history.' })
  listPlans(@Query() query: ListMembershipPlansQueryDto) {
    return this.service.listPlans(query);
  }

  @Post('plans/:planId/versions')
  @ApiCreatedResponse({ description: 'New draft version created without editing prior history.' })
  createVersion(
    @CurrentUser('id') actorId: string,
    @Param('planId', new ParseUUIDPipe({ version: '4' })) planId: string,
    @Body() input: CreateMembershipPlanVersionDto,
  ) {
    return this.service.createVersion(actorId, planId, input);
  }

  @Post('versions/:versionId/publish')
  publishVersion(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
  ) {
    return this.service.publishVersion(actorId, versionId);
  }

  @Post('versions/:versionId/archive')
  archiveVersion(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
  ) {
    return this.service.archiveVersion(actorId, versionId);
  }

  @Post('plans/:planId/archive')
  archivePlan(
    @CurrentUser('id') actorId: string,
    @Param('planId', new ParseUUIDPipe({ version: '4' })) planId: string,
  ) {
    return this.service.archivePlan(actorId, planId);
  }
}
