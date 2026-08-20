import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateJobDto } from './dto/create-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs-query.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { JobPage, JobResponse, JobsService, PublicJobDetail, PublicJobListItem } from './jobs.service';

@ApiTags('Jobs')
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get('jobs') @ApiOkResponse({ description: 'Paginated active published jobs returned.' })
  listPublic(@Query() query: ListJobsQueryDto): Promise<JobPage<PublicJobListItem>> { return this.jobs.listPublic(query); }

  @Get('jobs/:id') @ApiOkResponse({ description: 'Active published job detail returned.' }) @ApiNotFoundResponse({ description: 'Job not found.' })
  getPublic(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<PublicJobDetail> { return this.jobs.getPublic(id); }

  @Get('admin/jobs') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth() @ApiForbiddenResponse({ description: 'Platform administrator role required.' })
  listAdmin(@Query() query: ListJobsQueryDto): Promise<JobPage<JobResponse>> { return this.jobs.listAdmin(query); }

  @Get('admin/jobs/:id') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth()
  getAdmin(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<JobResponse> { return this.jobs.getAdmin(id); }

  @Post('admin/jobs') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth() @ApiCreatedResponse({ description: 'Draft job created.' })
  create(@CurrentUser('id') actorId: string, @Body() input: CreateJobDto): Promise<JobResponse> { return this.jobs.create(actorId, input); }

  @Patch('admin/jobs/:id') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth()
  update(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: UpdateJobDto): Promise<JobResponse> { return this.jobs.update(actorId, id, input); }

  @Post('admin/jobs/:id/publish') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth()
  publish(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<JobResponse> { return this.jobs.publish(actorId, id); }

  @Post('admin/jobs/:id/close') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth()
  close(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<JobResponse> { return this.jobs.close(actorId, id); }

  @Delete('admin/jobs/:id') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin) @ApiBearerAuth() @ApiOkResponse({ description: 'Job soft deleted.' })
  remove(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<{ deleted: true }> { return this.jobs.remove(actorId, id); }
}
