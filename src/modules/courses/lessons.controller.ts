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
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import {
  DeleteLessonResponse,
  LessonResponse,
  LessonsService,
  LessonSummary,
} from './lessons.service';

@ApiTags('Lessons')
@Controller()
export class LessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  @Get('courses/:courseId/lessons')
  @ApiOkResponse({ description: 'Published course lessons returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiNotFoundResponse({ description: 'Published public course not found.' })
  listLessons(
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<LessonSummary[]> {
    return this.lessonsService.listLessons(courseId);
  }

  @Post('courses/:courseId/lessons')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Lesson created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id or lesson payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Course not found for current user.' })
  @ApiConflictResponse({ description: 'Lesson slug or order index is already used.' })
  createLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: CreateLessonDto,
  ): Promise<LessonResponse> {
    return this.lessonsService.createLesson(user, courseId, input);
  }

  @Put('lessons/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Lesson updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid lesson id or payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Lesson not found for current user.' })
  @ApiConflictResponse({ description: 'Lesson slug or order index is already used.' })
  updateLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @Body() input: UpdateLessonDto,
  ): Promise<LessonResponse> {
    return this.lessonsService.updateLesson(user, lessonId, input);
  }

  @Delete('lessons/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Lesson soft deleted successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid lesson id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Lesson not found for current user.' })
  deleteLesson(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
  ): Promise<DeleteLessonResponse> {
    return this.lessonsService.deleteLesson(user, lessonId);
  }
}
