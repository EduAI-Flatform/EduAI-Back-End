import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { VoucherKind } from '../../../../generated/prisma/client';

const normalizeCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const normalizeCurrency = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const normalizeSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateVoucherDto {
  @ApiProperty({ example: 'EDUAI20' })
  @Transform(normalizeCode)
  @IsString()
  @Matches(/^[A-Z0-9_-]{3,64}$/)
  code!: string;

  @ApiProperty({ enum: VoucherKind, example: VoucherKind.percentage })
  @IsEnum(VoucherKind)
  kind!: VoucherKind;

  @ApiProperty({ example: 20, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  value!: number;

  @ApiProperty({ example: 'VND' })
  @Transform(normalizeCurrency)
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiProperty({ example: '2026-08-01T00:00:00.000Z' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minimumCoursePriceMinor?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maximumDiscountMinor?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  usageLimit?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  perUserLimit?: number | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  courseIds?: string[];

  @ApiPropertyOptional({ type: [String], example: ['ai-foundations'] })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((item) => normalizeSlug({ value: item })) : value,
  )
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
