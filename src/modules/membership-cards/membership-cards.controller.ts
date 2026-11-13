import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import type { MembershipCardPolicy } from './membership-card.evaluator';
import { computeMembershipCardForUser } from './membership-card-source';

export class MembershipImpactQuery {
  @IsOptional() @IsUUID('4') after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 50;
}

@ApiTags('Membership cards')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class MembershipCardsController {
  constructor(private readonly prisma: PrismaService, private readonly settings: PlatformSettingsService) {}

  @Get('membership-cards/me')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    const effective = await this.settings.current();
    const policy = effective.settings.membership as MembershipCardPolicy;
    const revisionId = effective.versions.membership ?? null;
    const evaluation = await this.prisma.$transaction(tx => computeMembershipCardForUser(tx, policy, revisionId, user.id), { isolationLevel: 'RepeatableRead' });
    return { policy: { enabled: policy.enabled, basis: policy.basis, currency: policy.currency, cycleMode: policy.cycleMode, cycleMonths: policy.cycleMonths, tiers: policy.tiers },
      evaluation, entitlementMigrationApplied: false, legacyPurchasedAccessPreserved: true };
  }

  @Get('admin/membership-cards/revisions/:revisionId/impact')
  @UseGuards(RolesGuard)
  @Roles(RoleName.platform_admin)
  async impact(@Param('revisionId', new ParseUUIDPipe({ version: '4' })) revisionId: string, @Query() query: MembershipImpactQuery) {
    const revision = await this.prisma.platformPolicyRevision.findUnique({ where: { id: revisionId } });
    if (!revision) throw new NotFoundException('Membership policy revision not found.');
    if (revision.group !== 'membership') {
      return { status: 'unavailable', reason: 'NOT_A_MEMBERSHIP_REVISION', policyRevisionId: revisionId, complete: false, items: [] };
    }
    const preview = await this.settings.preview(revisionId, query);
    return preview.membershipImpact;
  }
}
