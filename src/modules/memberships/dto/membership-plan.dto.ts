import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

export class ListMembershipAvailableCoursesQueryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1)
  page = 1;

  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100)
  pageSize = 25;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(120)
  search?: string;
}

export class CreateServiceEntitlementDefinitionDto {
  @ApiProperty({ pattern: '^[A-Za-z][A-Za-z0-9_]{1,63}$' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Za-z][A-Za-z0-9_]{1,63}$/)
  code!: string;

  @ApiProperty({ enum: ['BOOLEAN', 'METERED', 'UNLIMITED'] })
  @IsIn(['BOOLEAN', 'METERED', 'UNLIMITED'])
  valueType!: 'BOOLEAN' | 'METERED' | 'UNLIMITED';

  @ApiProperty({ enum: ['NONE', 'CALENDAR_MONTH', 'MEMBERSHIP_TERM'] })
  @IsIn(['NONE', 'CALENDAR_MONTH', 'MEMBERSHIP_TERM'])
  resetPeriod!: 'NONE' | 'CALENDAR_MONTH' | 'MEMBERSHIP_TERM';

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  displayName!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 40 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40)
  unitLabel?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, default: 0 })
  @IsOptional() @IsInt() @Min(0) @Max(1000)
  displayOrder = 0;
}

export class ConfigureMembershipPlanEntitlementDto {
  @ApiProperty({ format: 'uuid' })
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  definitionId!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsBoolean()
  booleanValue?: boolean | null;

  @ApiPropertyOptional({ nullable: true, pattern: '^[1-9][0-9]{0,18}$' })
  @IsOptional() @IsString() @Matches(/^[1-9][0-9]{0,18}$/)
  quota?: string | null;
}

export class ListServiceEntitlementDefinitionsQueryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1)
  page = 1;

  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100)
  pageSize = 25;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(120)
  search?: string;
}

export class ConfigureMembershipIncludedCourseDto {
  @ApiProperty({ format: 'uuid' })
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  courseId!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650, default: 0 })
  @IsOptional() @IsInt() @Min(0) @Max(3650)
  graceDays = 0;
}
