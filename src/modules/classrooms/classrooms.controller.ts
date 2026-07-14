import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
  ClassroomSessionResponse,
  ClassroomsService,
  DeletedClassroomSessionResponse,
  JoinedClassroomSessionResponse,
  StartedClassroomSessionResponse,
} from './classrooms.service';
import { CreateClassroomSessionDto } from './dto/create-classroom-session.dto';
import { UpdateClassroomSessionDto } from './dto/update-classroom-session.dto';

const MANAGER_ROLES = [RoleName.instructor, RoleName.platform_admin];

@ApiTags('Classrooms')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Required role missing.' })
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClassroomsController {
  constructor(private readonly classroomsService: ClassroomsService) {}

  @Post('courses/:courseId/classroom-sessions')
  @Roles(...MANAGER_ROLES)
  @ApiCreatedResponse({ description: 'Classroom session created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid classroom session payload.' })
  @ApiNotFoundResponse({ description: 'Owned course not found.' })
  createSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: CreateClassroomSessionDto,
  ): Promise<ClassroomSessionResponse> {
    return this.classroomsService.createSession(user, courseId, input);
  }

  @Get('courses/:courseId/classroom-sessions')
  @Roles(RoleName.student, ...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Role-visible classroom sessions returned.' })
  @ApiNotFoundResponse({ description: 'Owned or enrolled course not found.' })
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<ClassroomSessionResponse[]> {
    return this.classroomsService.listSessions(user, courseId);
  }

  @Get('classroom-sessions/:id')
  @Roles(RoleName.student, ...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Role-visible classroom session returned.' })
  @ApiNotFoundResponse({ description: 'Classroom session not found.' })
  getSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<ClassroomSessionResponse> {
    return this.classroomsService.getSession(user, sessionId);
  }

  @Put('classroom-sessions/:id')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned classroom session updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid classroom session payload.' })
  @ApiNotFoundResponse({ description: 'Owned classroom session not found.' })
  updateSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body() input: UpdateClassroomSessionDto,
  ): Promise<ClassroomSessionResponse> {
    return this.classroomsService.updateSession(user, sessionId, input);
  }

  @Delete('classroom-sessions/:id')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned classroom session deleted successfully.' })
  @ApiNotFoundResponse({ description: 'Owned classroom session not found.' })
  deleteSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<DeletedClassroomSessionResponse> {
    return this.classroomsService.deleteSession(user, sessionId);
  }

  @Post('classroom-sessions/:id/start')
  @Roles(RoleName.instructor)
  @ApiOkResponse({ description: 'Owned classroom session started.' })
  @ApiNotFoundResponse({ description: 'Owned classroom session not found.' })
  startSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<StartedClassroomSessionResponse> {
    return this.classroomsService.startSession(user, sessionId);
  }

  @Post('classroom-sessions/:id/join')
  @Roles(RoleName.student)
  @ApiOkResponse({ description: 'Live classroom join URL returned.' })
  @ApiNotFoundResponse({
    description: 'Live classroom session or enrollment not found.',
  })
  joinSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<JoinedClassroomSessionResponse> {
    return this.classroomsService.joinSession(user.id, sessionId);
  }
}
