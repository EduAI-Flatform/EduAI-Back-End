import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const AMOUNT = /^[1-9][0-9]{0,18}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,79}$/;
const REFERENCE = /^[A-Za-z0-9._:/-]{3,128}$/;

export class RefundAllocationDto {
  @IsUUID('4') orderLineId!: string;
  @Matches(AMOUNT) amountMinor!: string;
}
export class CreateRefundDto {
  @IsUUID('4') settlementId!: string;
  @IsOptional() @IsUUID('4') reconciliationCaseId?: string;
  @Matches(AMOUNT) amountMinor!: string;
  @Matches(CODE) reasonCode!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RefundAllocationDto)
  allocations!: RefundAllocationDto[];
}
export class RecordRefundDto {
  @Matches(REFERENCE) externalReference!: string;
  @IsBoolean() @Equals(true) confirmExternalAction!: true;
  @IsDateString() expectedUpdatedAt!: string;
}
export class RejectRefundDto {
  @Matches(CODE) rejectionReasonCode!: string;
  @IsDateString() expectedUpdatedAt!: string;
}
export class ListRefundsDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
}
