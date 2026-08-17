import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const LEARNING_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
type LearningLevel = (typeof LEARNING_LEVELS)[number];

function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class LearningSkillGapDto {
  @ApiProperty({ example: 'Machine Learning' })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: LEARNING_LEVELS, nullable: true })
  @IsOptional()
  @IsIn(LEARNING_LEVELS)
  currentLevel?: LearningLevel | null;

  @ApiProperty({ enum: LEARNING_LEVELS })
  @IsIn(LEARNING_LEVELS)
  targetLevel!: LearningLevel;
}

export class UpdateLearningProfileDto {
  @ApiPropertyOptional({ example: 'Build practical machine-learning skills.', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  learningGoal?: string | null;

  @ApiPropertyOptional({ enum: LEARNING_LEVELS, nullable: true })
  @IsOptional()
  @IsIn(LEARNING_LEVELS)
  currentLevel?: LearningLevel | null;

  @ApiPropertyOptional({ example: 6, minimum: 1, maximum: 168, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  weeklyAvailabilityHours?: number | null;

  @ApiPropertyOptional({ type: LearningSkillGapDto, isArray: true, maxItems: 12 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => LearningSkillGapDto)
  skillGaps?: LearningSkillGapDto[];
}
