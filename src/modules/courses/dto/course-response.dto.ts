import { ApiProperty } from '@nestjs/swagger';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
} from '../../../../generated/prisma/client';

export class CoursePriceDto {
  @ApiProperty({ example: 1499000, minimum: 0 })
  amountMinor!: number;

  @ApiProperty({ example: 'VND', minLength: 3, maxLength: 3 })
  currency!: string;
}

export class CourseInstructorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sarah Nguyen' })
  fullName!: string;

  @ApiProperty({ nullable: true, example: '/demo-assets/avatar-placeholder.svg' })
  avatarUrl!: string | null;

  @ApiProperty({ nullable: true, example: 'AI Instructor' })
  headline!: string | null;
}

export class CourseDetailInstructorDto extends CourseInstructorDto {
  @ApiProperty({ nullable: true })
  bio!: string | null;
}

export class CourseMetricsDto {
  @ApiProperty({ minimum: 0 })
  lessonCount!: number;

  @ApiProperty({ minimum: 0 })
  durationMinutes!: number;

  @ApiProperty({ minimum: 0 })
  enrollmentCount!: number;

  @ApiProperty({ nullable: true, minimum: 1, maximum: 5 })
  ratingAverage!: number | null;

  @ApiProperty({ minimum: 0 })
  ratingCount!: number;
}

export class CourseCatalogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty({ nullable: true })
  badge!: string | null;

  @ApiProperty({ nullable: true, minimum: 1 })
  featuredRank!: number | null;

  @ApiProperty({ type: CoursePriceDto, nullable: true })
  price!: CoursePriceDto | null;

  @ApiProperty({ enum: CourseLevel })
  level!: CourseLevel;

  @ApiProperty({ enum: CourseStatus })
  status!: CourseStatus;

  @ApiProperty({ enum: CourseVisibility })
  visibility!: CourseVisibility;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: CourseInstructorDto })
  instructor!: CourseInstructorDto;

  @ApiProperty({ type: CourseMetricsDto })
  metrics!: CourseMetricsDto;
}

export class CourseDetailResponseDto extends CourseCatalogResponseDto {
  @ApiProperty({ type: CourseDetailInstructorDto })
  declare instructor: CourseDetailInstructorDto;

  @ApiProperty({
    minimum: 0,
    description: 'Backward-compatible alias for metrics.lessonCount.',
  })
  lessonCount!: number;
}

export class PaginatedCourseResponseDto {
  @ApiProperty({ type: CourseCatalogResponseDto, isArray: true })
  items!: CourseCatalogResponseDto[];

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1 })
  pageSize!: number;

  @ApiProperty({ minimum: 0 })
  totalPages!: number;
}
