import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MentorSessionsService } from './mentor-sessions.service';

const SESSION_ROLES = [RoleName.student, RoleName.instructor, RoleName.platform_admin];

@ApiTags('Mentor sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('mentor-bookings/:bookingId/session')
export class MentorSessionsController {
  constructor(private readonly sessions: MentorSessionsService) {}

  @Post('join')
  @Roles(...SESSION_ROLES)
  @ApiOkResponse({ description: 'Authorized participant room URL and canonical join timestamp returned.' })
  @ApiNotFoundResponse({ description: 'Accepted participant-visible mentor booking not found.' })
  join(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string) {
    return this.sessions.join(user, bookingId);
  }

  @Post('leave')
  @Roles(...SESSION_ROLES)
  @ApiOkResponse({ description: 'Authorized participant leave timestamp recorded idempotently.' })
  @ApiNotFoundResponse({ description: 'Participant-visible mentor session attendance not found.' })
  leave(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string) {
    return this.sessions.leave(user, bookingId);
  }
}
