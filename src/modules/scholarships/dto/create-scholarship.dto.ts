import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique, IsArray, IsDateString, IsEnum, IsInt, IsOptional,
  IsString, IsUUID, Matches, Max, Min,
} from 'class-validator';
import {
  ScholarshipApplicationMode,
  ScholarshipBenefitKind,
} from '../../../../generated/prisma/client';

const normalizeText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normalizeCurrency = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const normalizeSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateScholarshipDto {
  @ApiProperty({ example: 'Học bổng AI Foundations 2026' })
  @Transform(normalizeText)
  @IsString()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({ enum: ScholarshipApplicationMode })
  @IsEnum(ScholarshipApplicationMode)
  applicationMode!: ScholarshipApplicationMode;

  @ApiProperty({ enum: ScholarshipBenefitKind })
  @IsEnum(ScholarshipBenefitKind)
  benefitKind!: ScholarshipBenefitKind;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  benefitValue!: number;

  @ApiPropertyOptional({ nullable: true, example: 'VND' })
  @Transform(normalizeCurrency)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string | null;

  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty()
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quota?: number | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  courseIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @Transform(({ value }) => Array.isArray(value) ? value.map((item) => normalizeSlug({ value: item })) : value)
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { each: true })
  categorySlugs?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  eligibleUserIds?: string[];
}
