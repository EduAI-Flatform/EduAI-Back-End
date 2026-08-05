import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateAssignmentDto {
  @ApiProperty({ example: 'Bài tập phân tích dữ liệu' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 10000 })
  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  instructions?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 10000 })
  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  rubric?: string | null;

  @ApiPropertyOptional({
    type: [String],
    default: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'image/jpeg',
      'image/png',
    ],
  })
  @IsOptional()
  @IsArray()
  @IsIn([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'image/jpeg',
    'image/png',
  ], { each: true })
  allowedFileMimeTypes?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 20971520, default: 20971520 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20971520)
  maxFileSizeBytes?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  lessonId?: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  @ApiProperty({ example: 10, minimum: 0.01, maximum: 10000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10000)
  maxScore!: number;
}
