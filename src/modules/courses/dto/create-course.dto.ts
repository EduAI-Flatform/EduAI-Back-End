import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
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

function normalizeOptionalInteger(value: unknown): unknown {
  if (value === null || value === undefined || value === '') {
    return value === '' ? undefined : value;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}

function IsCourseThumbnailUrl() {
  return ValidateBy({
    name: 'isCourseThumbnailUrl',
    validator: {
      validate(value: unknown): boolean {
        if (typeof value !== 'string') {
          return false;
        }

        if (
          /^\/demo-assets\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
            value,
          )
        ) {
          return true;
        }

        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      },
      defaultMessage(): string {
        return 'thumbnailUrl must be an http(s) URL or a safe /demo-assets path';
      },
    },
  });
}

export class CreateCourseDto {
  @ApiProperty({ example: 'AI Foundations' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiPropertyOptional({ example: 'ai-foundations' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

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
  @IsCourseThumbnailUrl()
  @MaxLength(2048)
  thumbnailUrl?: string | null;

  @ApiPropertyOptional({ example: 'Bestseller', nullable: true })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(50)
  badge?: string | null;

  @ApiPropertyOptional({ example: 'ai-foundations', nullable: true })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  categorySlug?: string | null;

  @ApiPropertyOptional({
    example: 1499000,
    minimum: 0,
    maximum: 2147483647,
    nullable: true,
    description: 'Price in the smallest currency unit.',
  })
  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  priceAmountMinor?: number | null;

  @ApiPropertyOptional({ example: 'VND', nullable: true })
  @Transform(({ value }) => {
    const normalized = normalizeOptionalString(value);
    return typeof normalized === 'string' ? normalized.toUpperCase() : normalized;
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  priceCurrency?: string | null;

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
