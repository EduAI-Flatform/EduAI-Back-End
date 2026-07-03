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
  ApiConflictResponse,
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
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import {
  AssignmentResponse,
  AssignmentsService,
  DeletedAssignmentResponse,
  SubmissionResponse,
} from './assignments.service';

const MANAGER_ROLES = [RoleName.instructor, RoleName.platform_admin];

@ApiTags('Assignments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Required role missing.' })
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post('courses/:courseId/assignments')
  @Roles(...MANAGER_ROLES)
  @ApiCreatedResponse({ description: 'Draft assignment created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid assignment payload.' })
  @ApiNotFoundResponse({ description: 'Owned course or lesson not found.' })
  createAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: CreateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.createAssignment(user, courseId, input);
  }

  @Get('courses/:courseId/assignments')
  @Roles(RoleName.student, ...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Role-visible assignments returned.' })
  @ApiNotFoundResponse({ description: 'Owned or enrolled course not found.' })
  listAssignments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<AssignmentResponse[]> {
    return this.assignmentsService.listAssignments(user, courseId);
  }

  @Get('assignments/:id')
  @Roles(RoleName.student, ...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Role-visible assignment returned.' })
  @ApiNotFoundResponse({ description: 'Assignment not found for current user.' })
  getAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.getAssignment(user, assignmentId);
  }

  @Put('assignments/:id')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned assignment updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid assignment payload.' })
  @ApiNotFoundResponse({ description: 'Owned assignment or lesson not found.' })
  updateAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
    @Body() input: UpdateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.updateAssignment(user, assignmentId, input);
  }

  @Delete('assignments/:id')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned assignment deleted successfully.' })
  @ApiNotFoundResponse({ description: 'Owned assignment not found.' })
  deleteAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
  ): Promise<DeletedAssignmentResponse> {
    return this.assignmentsService.deleteAssignment(user, assignmentId);
  }

  @Post('assignments/:id/publish')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned assignment published successfully.' })
  @ApiNotFoundResponse({ description: 'Owned assignment not found.' })
  publishAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.publishAssignment(user, assignmentId);
  }

  @Post('assignments/:id/submissions')
  @Roles(RoleName.student)
  @ApiCreatedResponse({ description: 'Assignment submission stored.' })
  @ApiBadRequestResponse({ description: 'Text or HTTPS file URL is required.' })
  @ApiConflictResponse({ description: 'Assignment already submitted.' })
  @ApiNotFoundResponse({
    description: 'Published assignment or student enrollment not found.',
  })
  submitAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
    @Body() input: SubmitAssignmentDto,
  ): Promise<SubmissionResponse> {
    return this.assignmentsService.submitAssignment(user.id, assignmentId, input);
  }

  @Get('assignments/:id/submissions/me')
  @Roles(RoleName.student)
  @ApiOkResponse({ description: 'Current student assignment submission returned.' })
  @ApiNotFoundResponse({
    description: 'Published assignment, enrollment, or submission not found.',
  })
  getMySubmission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
  ): Promise<SubmissionResponse> {
    return this.assignmentsService.getMySubmission(user.id, assignmentId);
  }

  @Get('assignments/:id/submissions')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned assignment submissions returned.' })
  @ApiNotFoundResponse({ description: 'Owned assignment not found.' })
  listSubmissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) assignmentId: string,
  ): Promise<SubmissionResponse[]> {
    return this.assignmentsService.listSubmissions(user, assignmentId);
  }

  @Post('submissions/:id/grade')
  @Roles(...MANAGER_ROLES)
  @ApiOkResponse({ description: 'Owned submission graded successfully.' })
  @ApiBadRequestResponse({ description: 'Score is outside assignment bounds.' })
  @ApiNotFoundResponse({ description: 'Owned submission not found.' })
  gradeSubmission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) submissionId: string,
    @Body() input: GradeSubmissionDto,
  ): Promise<SubmissionResponse> {
    return this.assignmentsService.gradeSubmission(user, submissionId, input);
  }
}
