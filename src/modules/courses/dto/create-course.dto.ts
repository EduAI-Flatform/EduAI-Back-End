import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CourseLevel, CourseVisibility } from '../../../../generated/prisma/enums';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class CreateCourseDto {
  @ApiProperty({ example: 'AI Foundations' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiProperty({ example: 'ai-foundations' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @ApiPropertyOptional({ example: 'Introductory AI course.', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional({
    example: 'https://example.com/course.png',
    nullable: true,
  })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  thumbnailUrl?: string | null;

  @ApiProperty({ enum: CourseLevel, example: CourseLevel.beginner })
  @IsEnum(CourseLevel)
  level!: CourseLevel;

  @ApiPropertyOptional({
    enum: CourseVisibility,
    example: CourseVisibility.public,
  })
  @IsOptional()
  @IsEnum(CourseVisibility)
  visibility?: CourseVisibility;
}
