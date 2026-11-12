import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiGoneResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
import { membershipSalesRetired } from './membership-sales-retired';

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
  @ApiGoneResponse({ description: 'New package authoring is retired. Configure GDS card policies instead.' })
  createPlan(@CurrentUser('id') actorId: string, @Body() input: CreateMembershipPlanDto) {
    return membershipSalesRetired();
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
  @ApiGoneResponse({ description: 'Package benefit authoring is retired; existing granted benefits are preserved.' })
  configurePlanEntitlement(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() input: ConfigureMembershipPlanEntitlementDto,
  ) {
    return membershipSalesRetired();
  }

  @Post('versions/:versionId/included-courses')
  @ApiGoneResponse({ description: 'Package course authoring is retired; existing purchased access is preserved.' })
  configureIncludedCourse(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() input: ConfigureMembershipIncludedCourseDto,
  ) {
    return membershipSalesRetired();
  }

  @Post('plans/:planId/versions')
  @ApiGoneResponse({ description: 'New package versions are retired. Configure GDS card policies instead.' })
  createVersion(
    @CurrentUser('id') actorId: string,
    @Param('planId', new ParseUUIDPipe({ version: '4' })) planId: string,
    @Body() input: CreateMembershipPlanVersionDto,
  ) {
    return membershipSalesRetired();
  }

  @Post('versions/:versionId/publish')
  @ApiGoneResponse({ description: 'Package publication is retired; historical versions remain available.' })
  publishVersion(
    @CurrentUser('id') actorId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
  ) {
    return membershipSalesRetired();
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
