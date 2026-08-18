import {
  Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse,
  ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ApplyScholarshipDto } from './dto/apply-scholarship.dto';
import { CreateScholarshipDto } from './dto/create-scholarship.dto';
import { ListScholarshipsQueryDto } from './dto/list-scholarships-query.dto';
import { UpdateScholarshipDto } from './dto/update-scholarship.dto';
import {
  ScholarshipApplicationPage, ScholarshipApplicationResponse, ScholarshipEligibilityResponse,
  ScholarshipPage, ScholarshipResponse, ScholarshipsService,
} from './scholarships.service';

@ApiTags('Scholarships')
@Controller()
export class ScholarshipsController {
  constructor(private readonly scholarshipsService: ScholarshipsService) {}

  @Post('admin/scholarships')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Scholarship campaign created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid scholarship policy or scope.' })
  createScholarship(
    @CurrentUser('id') actorId: string,
    @Body() input: CreateScholarshipDto,
  ): Promise<ScholarshipResponse> {
    return this.scholarshipsService.createScholarship(actorId, input);
  }

  @Get('admin/scholarships')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Scholarship campaigns returned successfully.' })
  listScholarships(@Query() query: ListScholarshipsQueryDto): Promise<ScholarshipPage> {
    return this.scholarshipsService.listScholarships(query);
  }

  @Get('admin/scholarships/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Scholarship campaign returned successfully.' })
  @ApiNotFoundResponse({ description: 'Scholarship campaign not found.' })
  getScholarship(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<ScholarshipResponse> {
    return this.scholarshipsService.getScholarship(id);
  }

  @Patch('admin/scholarships/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Scholarship campaign updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid scholarship policy or scope.' })
  @ApiConflictResponse({ description: 'Economic policy cannot change after awards.' })
  updateScholarship(
    @CurrentUser('id') actorId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateScholarshipDto,
  ): Promise<ScholarshipResponse> {
    return this.scholarshipsService.updateScholarship(actorId, id, input);
  }

  @Get('admin/scholarships/:id/applications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Scholarship application history returned successfully.' })
  listAdminApplications(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListScholarshipsQueryDto,
  ): Promise<ScholarshipApplicationPage> {
    return this.scholarshipsService.listApplications(query, id);
  }

  @Get('me/scholarships/applications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Current learner scholarship history returned successfully.' })
  listMyApplications(
    @CurrentUser('id') userId: string,
    @Query() query: ListScholarshipsQueryDto,
  ): Promise<ScholarshipApplicationPage> {
    return this.scholarshipsService.listApplications(query, undefined, userId);
  }

  @Get('scholarships/:id/preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Scholarship eligibility preview returned.' })
  preview(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<ScholarshipEligibilityResponse> {
    return this.scholarshipsService.preview(userId, id, courseId);
  }

  @Get('scholarships')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Eligible scholarship campaigns returned.' })
  listEligible(
    @CurrentUser('id') userId: string,
    @Query('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<ScholarshipResponse[]> {
    return this.scholarshipsService.listEligible(userId, courseId);
  }

  @Post('scholarships/:id/applications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Scholarship application/award recorded.' })
  @ApiBadRequestResponse({ description: 'Scholarship is not eligible.' })
  @ApiConflictResponse({ description: 'Scholarship policy conflict.' })
  apply(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ApplyScholarshipDto,
  ): Promise<ScholarshipApplicationResponse> {
    return this.scholarshipsService.apply(userId, id, input);
  }
}
