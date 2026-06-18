import {
  Body,
  Controller,
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
import { Course, RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@ApiTags('Courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  @ApiOkResponse({ description: 'Published public courses returned successfully.' })
  listCourses(): Promise<Course[]> {
    return this.coursesService.listCourses();
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Published public course returned successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id.' })
  @ApiNotFoundResponse({ description: 'Course not found.' })
  getCourse(
    @Param('id', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<Course> {
    return this.coursesService.getCourse(courseId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Course created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiConflictResponse({ description: 'Course slug is already in use.' })
  createCourse(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCourseDto,
  ): Promise<Course> {
    return this.coursesService.createCourse(user, input);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.instructor, RoleName.platform_admin)
  @ApiBearerAuth()
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
  ): Promise<Course> {
    return this.coursesService.updateCourse(user, courseId, input);
  }

  @Post(':id/publish')
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
  ): Promise<Course> {
    return this.coursesService.publishCourse(user, courseId);
  }

  @Post(':id/archive')
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
  ): Promise<Course> {
    return this.coursesService.archiveCourse(user, courseId);
  }
}
