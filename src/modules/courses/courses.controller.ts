import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
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
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES,
} from './course-thumbnail-storage.service';
import {
  CourseDetailResponse,
  CourseCommandResponse,
  CourseResponse,
  CourseProgressResponse,
  CoursesService,
  EnrollmentResponse,
  PaginatedCourseResponse,
  SuccessResponse,
} from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { ListInstructorCoursesQueryDto } from './dto/list-instructor-courses-query.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UploadedCourseThumbnail } from './types/course-thumbnail-upload.types';

const courseMutationMultipartProperties = {
  title: { type: 'string' },
  slug: { type: 'string' },
  description: { type: 'string', nullable: true },
  thumbnail: { type: 'string', format: 'binary' },
  thumbnailUrl: { type: 'string', format: 'uri', nullable: true },
  level: {
    type: 'string',
    enum: ['beginner', 'intermediate', 'advanced'],
  },
  visibility: { type: 'string', enum: ['public', 'private'] },
};

@ApiTags('Courses')
@Controller()
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get('courses')
  @ApiOkResponse({ description: 'Published public courses returned successfully.' })
  listCourses(): Promise<CourseResponse[]> {
    return this.coursesService.listCourses();
  }

  @Get('courses/:id')
  @ApiOkResponse({ description: 'Published public course returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiNotFoundResponse({ description: 'Course not found.' })
  getCourse(
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<CourseDetailResponse> {
    return this.coursesService.getCourse(courseId);
  }

  @Get('instructor/courses')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Instructor courses returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor role required.' })
  listInstructorCourses(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInstructorCoursesQueryDto,
  ): Promise<PaginatedCourseResponse> {
    return this.coursesService.listInstructorCourses(user, query);
  }

  @Post('courses')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @UseInterceptors(
    FileInterceptor('thumbnail', {
      limits: { fileSize: MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES },
    }),
  )
  @ApiBearerAuth()
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'level'],
      properties: courseMutationMultipartProperties,
    },
  })
  @ApiCreatedResponse({ description: 'Course created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiConflictResponse({ description: 'Course slug is already in use.' })
  createCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCourseDto,
    @UploadedFile() thumbnail?: UploadedCourseThumbnail,
  ): Promise<CourseCommandResponse> {
    return this.coursesService.createCourse(user, input, thumbnail);
  }

  @Put('courses/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @UseInterceptors(
    FileInterceptor('thumbnail', {
      limits: { fileSize: MAX_COURSE_THUMBNAIL_FILE_SIZE_BYTES },
    }),
  )
  @ApiBearerAuth()
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: courseMutationMultipartProperties,
    },
  })
  @ApiOkResponse({ description: 'Course updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id or payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Course not found for current user.' })
  @ApiConflictResponse({ description: 'Course slug is already in use.' })
  updateCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: UpdateCourseDto,
    @UploadedFile() thumbnail?: UploadedCourseThumbnail,
  ): Promise<CourseCommandResponse> {
    return this.coursesService.updateCourse(user, courseId, input, thumbnail);
  }

  @Post('courses/:id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Course published successfully.' })
  @ApiBadRequestResponse({
    description: 'Invalid course id or course has no lessons.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Course not found for current user.' })
  publishCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<CourseCommandResponse> {
    return this.coursesService.publishCourse(user, courseId);
  }

  @Post('courses/:id/archive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Course archived successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Course not found for current user.' })
  archiveCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<CourseCommandResponse> {
    return this.coursesService.archiveCourse(user, courseId);
  }

  @Post('courses/:id/enroll')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Course enrollment created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({ description: 'Published course not found.' })
  @ApiConflictResponse({ description: 'Course already enrolled.' })
  enrollCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<SuccessResponse> {
    return this.coursesService.enrollCourse(user.id, courseId);
  }

  @Get('me/enrollments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Current user enrollments returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  getMyEnrollments(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EnrollmentResponse[]> {
    return this.coursesService.getMyEnrollments(user.id);
  }

  @Post('lessons/:id/complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
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
    return this.coursesService.completeLesson(user.id, lessonId);
  }

  @Get('courses/:id/progress')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.student)
  @ApiBearerAuth()
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
    return this.coursesService.getCourseProgress(user.id, courseId);
  }
}
