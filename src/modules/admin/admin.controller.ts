import {
  Controller,
  Body,
  Get,
  Patch,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AdminUserResponse,
  AdminUserService,
  PaginatedAdminUserResponse,
} from './admin-user.service';
import { AdminOverviewResponse, AdminService } from './admin.service';
import { AdminOverviewResponseDto } from './dto/admin-overview-response.dto';
import {
  AdminUserResponseDto,
  PaginatedAdminUserResponseDto,
} from './dto/admin-user-response.dto';
import { PaginatedAuditLogResponseDto } from './dto/audit-log-response.dto';
import { ListAdminUsersQueryDto } from './dto/list-admin-users-query.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import {
  UpdateAdminUserRolesDto,
  UpdateAdminUserStatusDto,
} from './dto/update-admin-user.dto';

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
    private readonly adminUserService: AdminUserService,
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

  @Get('users')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Paginated sanitized platform users returned successfully.',
    type: PaginatedAdminUserResponseDto,
  })
  getUsers(
    @Query() query: ListAdminUsersQueryDto,
  ): Promise<PaginatedAdminUserResponse> {
    return this.adminUserService.listUsers(query);
  }

  @Get('users/:userId')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Sanitized platform user detail returned successfully.',
    type: AdminUserResponseDto,
  })
  @ApiNotFoundResponse({ description: 'User not found.' })
  getUser(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<AdminUserResponse> {
    return this.adminUserService.getUser(userId);
  }

  @Patch('users/:userId/status')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Account status updated and active sessions invalidated.',
    type: AdminUserResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Unsupported account status.' })
  @ApiConflictResponse({
    description: 'The last active platform administrator cannot be suspended.',
  })
  @ApiNotFoundResponse({ description: 'User not found.' })
  updateUserStatus(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateAdminUserStatusDto,
    @CurrentUser('id') actorId: string,
  ): Promise<AdminUserResponse> {
    return this.adminUserService.setStatus(actorId, userId, input.status);
  }

  @Patch('users/:userId/roles')
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({
    description: 'Supported roles replaced and active sessions invalidated.',
    type: AdminUserResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'At least one supported role is required.',
  })
  @ApiConflictResponse({
    description: 'The last active platform administrator cannot be removed.',
  })
  @ApiNotFoundResponse({ description: 'User not found.' })
  updateUserRoles(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateAdminUserRolesDto,
    @CurrentUser('id') actorId: string,
  ): Promise<AdminUserResponse> {
    return this.adminUserService.setRoles(actorId, userId, input.roles);
  }
}
