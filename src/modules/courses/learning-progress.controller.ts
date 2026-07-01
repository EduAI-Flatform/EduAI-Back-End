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
  CourseProgressResponse,
  LearningProgressService,
} from './learning-progress.service';

@ApiTags('Progress')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
@ApiBearerAuth()
export class LearningProgressController {
  constructor(
    private readonly learningProgressService: LearningProgressService,
  ) {}

  @Post('lessons/:id/complete')
  @ApiOkResponse({ description: 'Lesson marked complete successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid lesson id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({
    description: 'Lesson or enrollment not found for current student.',
  })
  completeLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
  ): Promise<CourseProgressResponse> {
    return this.learningProgressService.completeLesson(user.id, lessonId);
  }

  @Get('courses/:id/progress')
  @ApiOkResponse({ description: 'Course progress returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({
    description: 'Enrollment not found for current student.',
  })
  getCourseProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<CourseProgressResponse> {
    return this.learningProgressService.getCourseProgress(user.id, courseId);
  }
}
