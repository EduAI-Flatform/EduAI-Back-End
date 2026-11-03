import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';
import { RevenuePageDto, RevenueRetailPolicyDto } from './revenue-finance.dto';
import { AcceptRevenueParticipationDto, CreateRevenueTermsDto, RevenuePlanPolicyDto } from './revenue-membership.dto';

@ApiTags('Admin Revenue Sharing')
@ApiBearerAuth()
@Controller('admin/revenue-sharing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class RevenueAdminController {
  constructor(private readonly finance: RevenueFinanceService, private readonly memberships: RevenueMembershipService, private readonly prisma: PrismaService) {}
  @Get('state')
  async state() {
    const [retailPolicies, terms, planPolicies, plans] = await Promise.all([
      this.finance.listRetailPolicies(), this.memberships.listTerms(), this.memberships.listPolicies(),
      this.prisma.membershipPlan.findMany({ where: { status: 'active' }, orderBy: { code: 'asc' }, take: 100, select: { id: true, code: true, status: true, versions: { where: { status: 'published' }, orderBy: { versionNumber: 'desc' }, take: 1, select: { id: true, displayName: true, status: true, versionNumber: true, revenuePolicyId: true } } } }),
    ]);
    return { retailPolicies, terms, planPolicies, plans };
  }
  @Post('retail-policies')
  retail(@CurrentUser('id') actorId: string, @Body() input: RevenueRetailPolicyDto) { return this.finance.scheduleRetail(actorId, input); }
  @Post('terms')
  terms(@CurrentUser('id') actorId: string, @Body() input: CreateRevenueTermsDto) { return this.memberships.createTerms(actorId, input); }
  @Post('plan-policies/preview')
  preview(@Body() input: RevenuePlanPolicyDto) { return this.memberships.previewPolicy(input); }
  @Post('plan-policies')
  policy(@CurrentUser('id') actorId: string, @Body() input: RevenuePlanPolicyDto) { return this.memberships.schedulePolicy(actorId, input); }
  @Post('policies/:id/cancel')
  async cancel(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return await this.prisma.revenueRetailPolicy.findUnique({ where: { id } }) ? this.finance.cancelRetail(actorId, id) : this.memberships.cancelPolicy(actorId, id);
  }
  @Get('report')
  report(@Query() query: RevenuePageDto) { return this.finance.report(undefined, query.page, query.pageSize); }
}

@ApiTags('Seller Revenue Sharing')
@ApiBearerAuth()
@Controller('seller/revenue-sharing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.instructor, RoleName.platform_admin)
export class RevenueSellerController {
  constructor(private readonly finance: RevenueFinanceService, private readonly memberships: RevenueMembershipService) {}
  @Get('courses')
  courses(@CurrentUser('id') actorId: string, @Query() query: RevenuePageDto) { return this.memberships.listSellerCourses(actorId, query.page, query.pageSize); }
  @Get('courses/:id/preview')
  preview(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.memberships.previewCourse(actorId, id); }
  @Post('courses/:id/participation')
  accept(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: AcceptRevenueParticipationDto) { return this.memberships.accept(actorId, id, input); }
  @Delete('courses/:id/participation')
  leave(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.memberships.leave(actorId, id); }
  @Get('report')
  report(@CurrentUser('id') actorId: string, @Query() query: RevenuePageDto) { return this.finance.report(actorId, query.page, query.pageSize); }
}