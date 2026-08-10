import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import {
  AuditService,
  PaginatedAuditLogResponse,
} from '../../common/audit/audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOverviewResponse, AdminService } from './admin.service';
import { AdminOverviewResponseDto } from './dto/admin-overview-response.dto';
import { PaginatedAuditLogResponseDto } from './dto/audit-log-response.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Platform administrator role required.' })
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditService: AuditService,
  ) {}

  @Get('reports/overview')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Platform aggregate overview returned successfully.',
    type: AdminOverviewResponseDto,
  })
  getOverview(): Promise<AdminOverviewResponse> {
    return this.adminService.getOverview();
  }

  @Get('audit-logs')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Paginated platform audit records returned successfully.',
    type: PaginatedAuditLogResponseDto,
  })
  getAuditLogs(
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<PaginatedAuditLogResponse> {
    return this.auditService.list(query);
  }
}
