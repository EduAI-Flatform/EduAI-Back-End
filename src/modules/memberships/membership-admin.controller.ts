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
  ListMembershipAvailableCoursesQueryDto,
  CreateServiceEntitlementDefinitionDto,
  ConfigureMembershipPlanEntitlementDto,
  ListServiceEntitlementDefinitionsQueryDto,
  ConfigureMembershipIncludedCourseDto,
  EmergencyMembershipCourseRevocationDto,
} from './dto/membership-plan.dto';
import { MembershipAdminService } from './membership-admin.service';
import { MembershipContinuityService } from './membership-continuity.service';

@ApiTags('Admin Membership')
@ApiBearerAuth()
@Controller('admin/membership')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class MembershipAdminController {
  constructor(
    private readonly service: MembershipAdminService,
    private readonly continuity: MembershipContinuityService,
  ) {}

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

  @Get('available-courses')
  @ApiOkResponse({ description: 'Published, moderation-clear courses available for membership versions.' })
  listAvailableCourses(@Query() query: ListMembershipAvailableCoursesQueryDto) {
    return this.service.listAvailableCourses(query);
  }

  @Post('service-entitlements')
  createEntitlementDefinition(
    @CurrentUser('id') actorId: string,
    @Body() input: CreateServiceEntitlementDefinitionDto,
  ) {
    return this.service.createEntitlementDefinition(actorId, input);
  }

  @Get('service-entitlements')
  listEntitlementDefinitions(@Query() query: ListServiceEntitlementDefinitionsQueryDto) {
    return this.service.listEntitlementDefinitions(query);
  }

  @Post('versions/:versionId/service-entitlements')
  configurePlanEntitlement(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() input: ConfigureMembershipPlanEntitlementDto,
  ) {
    return this.service.configurePlanEntitlement(actorId, versionId, input);
  }

  @Post('versions/:versionId/included-courses')
  configureIncludedCourse(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() input: ConfigureMembershipIncludedCourseDto,
  ) {
    return this.service.configureIncludedCourse(actorId, versionId, input);
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

  @Post('course-access/emergency-revoke')
  @ApiOkResponse({ description: 'Immediately revokes only membership-derived course access with an immutable administrator audit event.' })
  emergencyRevokeCourseAccess(
    @CurrentUser('id') actorId: string,
    @Body() input: EmergencyMembershipCourseRevocationDto,
  ) {
    return this.continuity.emergencyRevoke(actorId, input);
  }
}
