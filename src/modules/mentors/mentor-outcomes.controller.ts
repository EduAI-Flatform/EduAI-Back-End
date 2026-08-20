import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateMentorGoalDto, MentorNoteDto, MentorReviewDto, UpdateMentorGoalDto } from './dto/mentor-outcome.dto';
import { MentorOutcomesService } from './mentor-outcomes.service';

const PARTICIPANTS = [RoleName.student, RoleName.instructor];
@ApiTags('Mentor outcomes') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('mentor-bookings/:bookingId')
export class MentorOutcomesController {
  constructor(private readonly outcomes: MentorOutcomesService) {}
  @Get('outcomes') @Roles(...PARTICIPANTS)
  get(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string) { return this.outcomes.get(user, id); }
  @Put('private-note') @Roles(RoleName.instructor)
  privateNote(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: MentorNoteDto) { return this.outcomes.savePrivateNote(user, id, input.content); }
  @Put('shared-note') @Roles(RoleName.instructor)
  sharedNote(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: MentorNoteDto) { return this.outcomes.saveSharedNote(user, id, input.content); }
  @Post('goals') @Roles(RoleName.instructor)
  createGoal(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: CreateMentorGoalDto) { return this.outcomes.createGoal(user, id, input.content); }
  @Patch('goals/:goalId') @Roles(...PARTICIPANTS)
  updateGoal(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string, @Param('goalId', new ParseUUIDPipe({ version: '4' })) goalId: string, @Body() input: UpdateMentorGoalDto) { return this.outcomes.updateGoal(user, id, goalId, input.status); }
  @Post('complete') @Roles(RoleName.instructor)
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string) { return this.outcomes.complete(user, id); }
  @Put('review') @Roles(RoleName.student)
  review(@CurrentUser('id') studentId: string, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: MentorReviewDto) { return this.outcomes.saveReview(studentId, id, input); }
}
