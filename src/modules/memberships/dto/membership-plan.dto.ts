import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class MembershipDurationInputDto {
  @ApiProperty({ minimum: 1, maximum: 120 })
  @IsInt() @Min(1) @Max(120)
  months!: number;

  @ApiPropertyOptional({ pattern: '^(0|[1-9][0-9]{0,18})$', example: '120000' })
  @IsOptional() @IsString() @Matches(/^(0|[1-9][0-9]{0,18})$/)
  priceAmountMinor?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  discountPercent?: number;

  @ApiProperty({ minimum: 0, maximum: 1000 })
  @IsInt() @Min(0) @Max(1000)
  displayOrder!: number;
}

export class CreateMembershipPlanVersionDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  displayName!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ pattern: '^(0|[1-9][0-9]{0,18})$', example: '100000' })
  @IsString() @Matches(/^(0|[1-9][0-9]{0,18})$/)
  baseMonthlyPriceAmountMinor!: string;

  @ApiProperty({ enum: ['VND'] })
  @IsIn(['VND'])
  currency!: 'VND';

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional() @IsDateString()
  salesStartAt?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional() @IsDateString()
  salesEndAt?: string | null;

  @ApiProperty({ type: [MembershipDurationInputDto], minItems: 1, maxItems: 24 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(24)
  @ValidateNested({ each: true }) @Type(() => MembershipDurationInputDto)
  durations!: MembershipDurationInputDto[];
}

export class CreateMembershipPlanDto extends CreateMembershipPlanVersionDto {
  @ApiProperty({ pattern: '^[A-Za-z0-9_-]{2,64}$' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString() @Matches(/^[A-Za-z0-9_-]{2,64}$/)
  code!: string;
}

export class ListMembershipPlansQueryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1)
  page = 1;

  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100)
  pageSize = 25;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(120)
  search?: string;

  @IsOptional() @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}
