import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ApplyToJobDto, ListJobApplicationsQueryDto, UpdateJobApplicationStatusDto } from './dto/job-application.dto';
import { JobApplicationsService } from './job-applications.service';

@ApiTags('Job applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class JobApplicationsController {
  constructor(private readonly applications: JobApplicationsService) {}

  @Post('jobs/:jobId/saved') @Roles(RoleName.student) @ApiCreatedResponse({ description: 'Job saved for current learner.' })
  save(@CurrentUser('id') userId: string, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) { return this.applications.save(userId, jobId); }

  @Delete('jobs/:jobId/saved') @Roles(RoleName.student)
  unsave(@CurrentUser('id') userId: string, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) { return this.applications.unsave(userId, jobId); }

  @Get('me/saved-jobs') @Roles(RoleName.student)
  listSaved(@CurrentUser('id') userId: string, @Query() query: ListJobApplicationsQueryDto) { return this.applications.listSaved(userId, query); }

  @Post('jobs/:jobId/applications') @Roles(RoleName.student) @ApiCreatedResponse({ description: 'Private learner application submitted.' })
  apply(@CurrentUser('id') userId: string, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string, @Body() input: ApplyToJobDto) { return this.applications.apply(userId, jobId, input); }

  @Get('me/job-applications') @Roles(RoleName.student)
  listMine(@CurrentUser('id') userId: string, @Query() query: ListJobApplicationsQueryDto) { return this.applications.listMine(userId, query); }

  @Get('me/job-applications/:id') @Roles(RoleName.student)
  getMine(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.applications.getMine(userId, id); }

  @Post('me/job-applications/:id/withdraw') @Roles(RoleName.student)
  withdraw(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.applications.withdraw(userId, id); }

  @Get('admin/job-applications') @Roles(RoleName.platform_admin) @ApiForbiddenResponse({ description: 'Platform administrator role required.' })
  listAdmin(@Query() query: ListJobApplicationsQueryDto) { return this.applications.listAdmin(query); }

  @Patch('admin/job-applications/:id/status') @Roles(RoleName.platform_admin) @ApiOkResponse({ description: 'Application status and immutable history updated.' })
  updateStatus(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: UpdateJobApplicationStatusDto) { return this.applications.updateStatus(actorId, id, input); }
}
