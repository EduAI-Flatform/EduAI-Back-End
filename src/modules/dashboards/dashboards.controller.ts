import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  DashboardsService,
  InstructorDashboardResponse,
  StudentDashboardResponse,
} from './dashboards.service';
import {
  InstructorDashboardResponseDto,
  StudentDashboardResponseDto,
} from './dto/dashboard-response.dto';

@ApiTags('Dashboards')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Required role missing.' })
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardsController {
  constructor(private readonly dashboardsService: DashboardsService) {}

  @Get('me/dashboard')
  @Roles(RoleName.student)
  @ApiOkResponse({
    description: 'Current student dashboard returned successfully.',
    type: StudentDashboardResponseDto,
  })
  getStudentDashboard(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StudentDashboardResponse> {
    return this.dashboardsService.getStudentDashboard(user.id);
  }

  @Get('instructor/dashboard')
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Instructor aggregate dashboard returned successfully.',
    type: InstructorDashboardResponseDto,
  })
  getInstructorDashboard(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InstructorDashboardResponse> {
    return this.dashboardsService.getInstructorDashboard(user);
  }
}
