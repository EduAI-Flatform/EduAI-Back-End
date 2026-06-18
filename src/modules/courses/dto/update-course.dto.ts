import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { CourseStatus } from '../../../../generated/prisma/enums';
import { CreateCourseDto } from './create-course.dto';

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @ApiPropertyOptional({ enum: CourseStatus, example: CourseStatus.published })
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;
}
