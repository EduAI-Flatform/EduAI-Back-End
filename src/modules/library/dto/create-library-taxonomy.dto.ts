import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeOptional(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return typeof value === 'string' ? value.trim() || null : value;
}

export class CreateLibraryCategoryDto {
  @ApiProperty({ example: 'Lập trình' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'lap-trinh' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @ApiPropertyOptional({ example: 'Tài liệu về lập trình.', nullable: true })
  @Transform(({ value }) => normalizeOptional(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class UpdateLibraryCategoryDto {
  @ApiPropertyOptional({ example: 'Lập trình' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'lap-trinh' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @ApiPropertyOptional({ example: 'Tài liệu về lập trình.', nullable: true })
  @Transform(({ value }) => normalizeOptional(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class CreateLibraryTagDto {
  @ApiProperty({ example: 'TypeScript' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ example: 'typescript' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;
}

export class UpdateLibraryTagDto {
  @ApiPropertyOptional({ example: 'TypeScript' })
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'typescript' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;
}
