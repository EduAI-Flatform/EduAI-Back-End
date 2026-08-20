import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateMentorBookingDto, ListMentorBookingsQueryDto, MentorBookingReasonDto, RescheduleMentorBookingDto } from './dto/mentor-booking.dto';
import { MentorBookingsService } from './mentor-bookings.service';

@ApiTags('Mentor bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class MentorBookingsController {
  constructor(private readonly bookings: MentorBookingsService) {}

  @Post('mentors/:mentorId/bookings') @Roles(RoleName.student)
  create(@CurrentUser('id') studentId: string, @Param('mentorId', new ParseUUIDPipe({ version: '4' })) mentorId: string, @Body() input: CreateMentorBookingDto) { return this.bookings.create(studentId, mentorId, input); }
  @Get('mentor-bookings') @Roles(RoleName.student)
  listStudent(@CurrentUser('id') studentId: string, @Query() query: ListMentorBookingsQueryDto) { return this.bookings.listStudent(studentId, query); }
  @Get('mentor/bookings') @Roles(RoleName.instructor)
  listMentor(@CurrentUser('id') mentorId: string, @Query() query: ListMentorBookingsQueryDto) { return this.bookings.listMentor(mentorId, query); }

  @Patch('mentor-bookings/:id/accept') @Roles(RoleName.student, RoleName.instructor)
  accept(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.bookings.accept(actorId, id); }
  @Patch('mentor-bookings/:id/reject') @Roles(RoleName.student, RoleName.instructor)
  reject(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: MentorBookingReasonDto) { return this.bookings.reject(actorId, id, input); }
  @Patch('mentor-bookings/:id/cancel') @Roles(RoleName.student, RoleName.instructor)
  cancel(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: MentorBookingReasonDto) { return this.bookings.cancel(actorId, id, input); }
  @Patch('mentor-bookings/:id/reschedule') @Roles(RoleName.student, RoleName.instructor)
  reschedule(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() input: RescheduleMentorBookingDto) { return this.bookings.reschedule(actorId, id, input); }
}
