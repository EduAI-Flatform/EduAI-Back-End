import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
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
  CoursesService,
  PaginatedCourseResponse,
} from './courses.service';
import { ListInstructorCoursesQueryDto } from './dto/list-instructor-courses-query.dto';

@ApiTags('Instructor Courses')
@Controller('instructor/courses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.instructor)
@ApiBearerAuth()
export class InstructorCoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  @ApiOkResponse({ description: 'Instructor courses returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor role required.' })
  listInstructorCourses(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInstructorCoursesQueryDto,
  ): Promise<PaginatedCourseResponse> {
    return this.coursesService.listInstructorCourses(user, query);
  }
}
