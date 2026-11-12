import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
export class AffiliateIdentityDto { @IsIn(['general', 'instructor']) kind!: 'general' | 'instructor'; }
export class AffiliateVisitDto { @Matches(/^[a-f0-9]{30}$/) code!: string; }
export class AffiliateAttributionDto {
  @IsUUID('4') orderId!: string;
  @Matches(/^[a-f0-9]{64}$/) visitToken!: string;
}
export class AffiliateReconcileDto { @IsOptional() @IsUUID('4') after?: string; }
export class AffiliateListQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['general', 'instructor']) kind?: 'general' | 'instructor';
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
