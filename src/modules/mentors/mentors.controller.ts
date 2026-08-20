import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ListMentorsQueryDto, SetMentorActiveDto, SetMentorApprovalDto, UpdateMentorProfileDto } from './dto/mentor.dto';
import { MentorsService } from './mentors.service';

@ApiTags('Mentors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class MentorsController {
  constructor(private readonly mentors: MentorsService) {}

  @Get('mentor/profile') @Roles(RoleName.instructor)
  getMine(@CurrentUser('id') userId: string) { return this.mentors.getMine(userId); }
  @Put('mentor/profile') @Roles(RoleName.instructor)
  updateMine(@CurrentUser('id') userId: string, @Body() input: UpdateMentorProfileDto) { return this.mentors.updateMine(userId, input); }
  @Patch('mentor/profile/active') @Roles(RoleName.instructor)
  setActive(@CurrentUser('id') userId: string, @Body() input: SetMentorActiveDto) { return this.mentors.setActive(userId, input.isActive); }

  @Get('mentors') @Roles(RoleName.student) @ApiOkResponse({ description: 'Paginated active approved mentor directory without private contact data.' })
  list(@Query() query: ListMentorsQueryDto) { return this.mentors.listDirectory(query); }
  @Get('mentors/:id') @Roles(RoleName.student)
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.mentors.getDirectory(id); }

  @Get('admin/mentors') @Roles(RoleName.platform_admin)
  listAdmin(@Query() query: ListMentorsQueryDto) { return this.mentors.listAdmin(query); }
  @Patch('admin/mentors/:id/approval') @Roles(RoleName.platform_admin)
  setApproval(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: SetMentorApprovalDto) { return this.mentors.setApproval(actorId, id, input); }
}
