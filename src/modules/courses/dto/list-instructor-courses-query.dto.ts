import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CourseStatus } from '../../../../generated/prisma/enums';

function normalizeStatus(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, CourseStatus> = {
    deleted: CourseStatus.archived,
    private: CourseStatus.draft,
  };

  return aliases[normalized] ?? normalized;
}

function normalizeSearch(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class ListInstructorCoursesQueryDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({
    enum: CourseStatus,
    description: 'Case-insensitive. Private maps to draft; Deleted maps to archived.',
  })
  @Transform(({ value }) => normalizeStatus(value))
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;

  @ApiPropertyOptional({ example: 'React' })
  @Transform(({ value }) => normalizeSearch(value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
