import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
import {
  EnrollmentResponse,
  EnrollmentsService,
} from './enrollments.service';

@ApiTags('Enrollments')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
@ApiBearerAuth()
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Post('courses/:id/enroll')
  @ApiCreatedResponse({ description: 'Course enrollment created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({ description: 'Published course not found.' })
  @ApiConflictResponse({ description: 'Course already enrolled.' })
  enrollCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<EnrollmentResponse> {
    return this.enrollmentsService.enrollCourse(user.id, courseId);
  }

  @Get('me/enrollments')
  @ApiOkResponse({ description: 'Current user enrollments returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  getMyEnrollments(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EnrollmentResponse[]> {
    return this.enrollmentsService.getMyEnrollments(user.id);
  }
}
