import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateRevenueTermsDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(160)
  title!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(30000)
  body!: string;
}
export class AcceptRevenueParticipationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4')
  termsId!: string;
}
export class RevenueMatchingRuleDto {
  @ApiProperty() @IsInt() @Min(0) @Max(1000000)
  priority!: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsString({ each: true }) @MaxLength(120, { each: true })
  categorySlugs?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(3) @ArrayUnique() @IsIn(['beginner', 'intermediate', 'advanced'], { each: true })
  levels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/)
  minPriceAmountMinor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^(0|[1-9][0-9]{0,12})$/)
  maxPriceAmountMinor?: string;
  @ApiProperty({ default: 1 }) @IsInt() @Min(1) @Max(1000000)
  weight = 1;
}
export class RevenueWeightOverrideDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4')
  courseId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(1000000)
  weight!: number;
}
export class RevenuePlanPolicyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4')
  planId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4')
  sourceVersionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4')
  termsId!: string;
  @ApiProperty({ minimum: 0, maximum: 10000 }) @IsInt() @Min(0) @Max(10000)
  platformFeeBps!: number;
  @ApiProperty({ type: [RevenueMatchingRuleDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RevenueMatchingRuleDto)
  rules!: RevenueMatchingRuleDto[];
  @ApiPropertyOptional({ type: [RevenueWeightOverrideDto] }) @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => RevenueWeightOverrideDto)
  overrides: RevenueWeightOverrideDto[] = [];
  @ApiProperty({ enum: ['immediate', 'delayed'] }) @IsIn(['immediate', 'delayed'])
  noticeMode!: 'immediate' | 'delayed';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(3650)
  noticeDays?: number;
}
