import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LegacyMembershipReportService } from './legacy-membership-report.service';
import { LegacyMembershipInventoryService } from './legacy-membership-inventory.service';
import { LegacyMembershipInventoryQuery } from './dto/legacy-membership-inventory.dto';

@ApiTags('Admin Membership')
@ApiBearerAuth()
@Controller('admin/membership/legacy-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class LegacyMembershipReportController {
  constructor(private readonly reportService: LegacyMembershipReportService, private readonly inventoryService: LegacyMembershipInventoryService) {}

  @Get('inventory')
  @ApiOkResponse({ description: 'Read-only paginated legacy source inventory, including orphaned and unverified rights. Linked orders still require reconciliation; page exhaustion is not migration approval.' })
  inventory(@Query() query: LegacyMembershipInventoryQuery) {
    return this.inventoryService.list(query);
  }

  @Get(':orderId/reconciliation')
  @ApiOkResponse({ description: 'Bounded read-only historical membership reconciliation. Findings never authorize automatic repair, renewal or quota reset.' })
  report(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string) {
    return this.reportService.report(orderId);
  }
}
