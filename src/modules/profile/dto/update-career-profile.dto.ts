import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
const AVAILABILITY_STATUSES = [
  'not_looking',
  'open_to_opportunities',
  'actively_looking',
] as const;

function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : item))]
    .filter((item) => item !== '');
}

export class UpdateCareerProfileDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  careerGoal?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 10 })
  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  preferredRoles?: string[];

  @ApiPropertyOptional({ enum: WORK_MODES, isArray: true })
  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(WORK_MODES, { each: true })
  preferredWorkModes?: string[];

  @ApiPropertyOptional({ enum: AVAILABILITY_STATUSES, nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsIn(AVAILABILITY_STATUSES)
  availabilityStatus?: string | null;

  @ApiPropertyOptional({ example: '2026-09-01', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsDateString()
  availableFrom?: string | null;

  @ApiPropertyOptional({ example: 'nguyen-van-an', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  publicSlug?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
