import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class GradeSubmissionDto {
  @ApiProperty({ example: 8.5, minimum: 0, maximum: 10000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000)
  score!: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 10000 })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  feedback?: string | null;
}
