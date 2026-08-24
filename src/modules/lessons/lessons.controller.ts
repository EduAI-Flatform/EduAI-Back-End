import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Put,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { RoleName } from '../../../generated/prisma/client';
import { Public } from '../../common/security/public.decorator';
import {
  UploadAuthorizationRateLimit,
  UploadRateLimit,
} from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Optional } from '@nestjs/common';
import { LearningPathService } from '../courses/learning-path.service';
import { UpdateLessonProgressDto } from '../courses/dto/update-lesson-progress.dto';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { LessonDetailDto } from './dto/lesson-response.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import { AuthorizeVideoUploadDto } from './dto/authorize-video-upload.dto';
import { FinalizeVideoUploadDto } from './dto/finalize-video-upload.dto';
import { DiscardLessonMediaDto } from './dto/discard-lesson-media.dto';
import {
  MAX_LESSON_DOCUMENT_SIZE_BYTES,
} from './lesson-media-storage.service';
import { UploadedLessonDocument } from './types/lesson-media-upload.types';
import {
  DeleteLessonResponse,
  LessonResponse,
  LessonsService,
  LessonSummary,
} from './lessons.service';

@ApiTags('Lessons')
@Controller()
export class LessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    @Optional() private readonly learningPathService?: LearningPathService,
  ) {}

  @Get('courses/:courseId/lessons')
  @Public()
  @ApiOkResponse({ description: 'Published course lessons returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiNotFoundResponse({ description: 'Published public course not found.' })
  listLessons(
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<LessonSummary[]> {
    return this.lessonsService.listLessons(courseId);
  }

  @Get('lessons/:id')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Authorized lesson content returned successfully.',
    type: LessonDetailDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid lesson id.' })
  @ApiUnauthorizedResponse({ description: 'Supplied access token is invalid.' })
  @ApiNotFoundResponse({ description: 'Lesson not found or not accessible.' })
  getLesson(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
  ): Promise<LessonResponse> {
    return this.lessonsService.getLesson(user, lessonId);
  }

  @Patch('lessons/:id/progress')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Lesson progress updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid progress payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({ description: 'Lesson or learner access not found.' })
  updateLessonProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @Body() input: UpdateLessonProgressDto,
  ): Promise<unknown> {
    if (!this.learningPathService) {
      throw new Error('Learning path service is not configured');
    }
    return this.learningPathService.updateLessonProgress(user, lessonId, input);
  }

  @Get('lessons/:id/progress')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Lesson progress returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({ description: 'Lesson, learner access, or learning step not found.' })
  getLessonProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) lessonId: string,
  ): Promise<unknown> {
    if (!this.learningPathService) {
      throw new Error('Learning path service is not configured');
    }
    return this.learningPathService.getLessonProgress(user, lessonId);
  }

  @Get('instructor/courses/:courseId/lessons')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Instructor course lessons returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Course not found for current user.' })
  listInstructorLessons(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<LessonSummary[]> {
    return this.lessonsService.listInstructorLessons(user, courseId);
  }

  @Post('courses/:courseId/lesson-media/video-upload-url')
  @UploadAuthorizationRateLimit()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Short-lived direct R2 upload authorization returned.' })
  authorizeVideoUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: AuthorizeVideoUploadDto,
  ) {
    return this.lessonsService.authorizeVideoUpload(
      user,
      courseId,
      input.mimeType,
      input.size,
    );
  }

  @Post('courses/:courseId/lesson-media/video-finalize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Uploaded R2 object verified and finalized.' })
  finalizeVideoUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: FinalizeVideoUploadDto,
  ) {
    return this.lessonsService.finalizeVideoUpload(
      user,
      courseId,
      input.storageKey,
      input.mimeType,
      input.size,
    );
  }

  @Post('courses/:courseId/lesson-media/documents')
  @UploadRateLimit()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_LESSON_DOCUMENT_SIZE_BYTES },
    }),
  )
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ description: 'Private lesson PDF uploaded.' })
  uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @UploadedFile() file?: UploadedLessonDocument,
  ) {
    return this.lessonsService.uploadDocument(user, courseId, file);
  }

  @Post('courses/:courseId/lesson-media/discard')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Unattached lesson media discarded.' })
  discardMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: DiscardLessonMediaDto,
  ) {
    return this.lessonsService.discardMedia(user, courseId, input.storageKey);
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
