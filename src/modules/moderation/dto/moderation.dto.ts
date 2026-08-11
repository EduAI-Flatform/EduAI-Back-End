import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ModerationStatus } from '../../../../generated/prisma/client';
import {
  MODERATION_ACTIONS,
  MODERATION_TARGET_TYPES,
  ModerationActionValue,
  ModerationTargetType,
  ModerationTargetTypeValue,
} from '../moderation.constants';

function trimOptional(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimRequired(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class ListModerationQueryDto {
  @ApiPropertyOptional({
    enum: MODERATION_TARGET_TYPES,
    default: ModerationTargetType.Course,
  })
  @IsIn(MODERATION_TARGET_TYPES)
  targetType: ModerationTargetTypeValue = ModerationTargetType.Course;

  @ApiPropertyOptional({ enum: ModerationStatus })
  @IsOptional()
  @IsEnum(ModerationStatus)
  status?: ModerationStatus;

  @ApiPropertyOptional({ example: 'calculus' })
  @Transform(({ value }) => trimOptional(value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 25;
}

export class ModerationTargetParamsDto {
  @ApiProperty({ enum: MODERATION_TARGET_TYPES })
  @IsIn(MODERATION_TARGET_TYPES)
  targetType!: ModerationTargetTypeValue;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId!: string;
}

export class ModerateTargetDto {
  @ApiProperty({ enum: MODERATION_ACTIONS })
  @IsIn(MODERATION_ACTIONS)
  action!: ModerationActionValue;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) => trimRequired(value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
