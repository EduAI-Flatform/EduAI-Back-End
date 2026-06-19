import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { LessonType } from '../../../../generated/prisma/enums';

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

export class CreateLessonDto {
  @ApiProperty({ example: 'Introduction' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiProperty({ example: 'introduction' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @ApiProperty({ enum: LessonType, example: LessonType.video })
  @IsEnum(LessonType)
  type!: LessonType;

  @ApiPropertyOptional({ example: 'Lesson article content.', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  content?: string | null;

  @ApiPropertyOptional({
    example: 'https://example.com/video.mp4',
    nullable: true,
  })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  videoUrl?: string | null;

  @ApiPropertyOptional({
    example: 'https://example.com/lesson.pdf',
    nullable: true,
  })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  documentUrl?: string | null;

  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt()
  @Min(0)
  orderIndex!: number;

  @ApiPropertyOptional({ example: 12, minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMinutes?: number | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isPreview?: boolean;
}
