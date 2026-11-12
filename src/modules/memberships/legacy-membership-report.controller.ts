import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LegacyMembershipReportService } from './legacy-membership-report.service';

@ApiTags('Admin Membership')
@ApiBearerAuth()
@Controller('admin/membership/legacy-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class LegacyMembershipReportController {
  constructor(private readonly reportService: LegacyMembershipReportService) {}

  @Get(':orderId/reconciliation')
  @ApiOkResponse({ description: 'Bounded read-only historical membership reconciliation. Findings never authorize automatic repair, renewal or quota reset.' })
  report(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string) {
    return this.reportService.report(orderId);
  }
}
