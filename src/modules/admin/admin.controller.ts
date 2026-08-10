import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOverviewResponse, AdminService } from './admin.service';
import { AdminOverviewResponseDto } from './dto/admin-overview-response.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Platform administrator role required.' })
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('reports/overview')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Platform aggregate overview returned successfully.',
    type: AdminOverviewResponseDto,
  })
  getOverview(): Promise<AdminOverviewResponse> {
    return this.adminService.getOverview();
  }
}
