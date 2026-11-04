import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { WITHDRAWAL_STATUSES } from '../gds-withdrawal.domain';

export class GdsCreateWithdrawalDto {
  @IsString() @Matches(/^[1-9]\d{0,15}$/) amountMinor!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{2,32}$/) bankCode!: string;
  @IsString() @Matches(/^[0-9]{6,34}$/) accountNumber!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @Length(2, 160) @Matches(/^[^\x00-\x1f\x7f]+$/) accountHolder?: string;
  @IsOptional() @IsUUID('4') verificationId?: string;
}
export class GdsVerifyAccountDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{2,32}$/) bankCode!: string;
  @IsString() @Matches(/^[0-9]{6,19}$/) accountNumber!: string;
}
export class GdsWithdrawalPageDto {
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsIn(WITHDRAWAL_STATUSES) status?: string;
}
export class GdsWithdrawalSettingsDto {
  @IsString() @Matches(/^[1-9]\d{0,15}$/) minimumMinor!: string;
  @IsString() @Matches(/^[1-9]\d{0,15}$/) maximumMinor!: string;
  @IsInt() @Min(1) version!: number;
  @IsBoolean() admissionEnabled!: boolean;
  @IsBoolean() processingEnabled!: boolean;
  @IsOptional() @IsBoolean() accountVerificationRequired?: boolean;
}
export class GdsWithdrawalActionDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 500) reason!: string;
  @IsOptional() @IsString() @Length(1, 160) @Matches(/^[^\x00-\x1f\x7f]+$/) bankTransactionRef?: string;
  @IsOptional() @IsISO8601({ strict: true }) transferredAt?: string;
}
export class GdsRevenueReviewDto {
  @IsString() @Matches(/^(0|[1-9]\d{0,15})$/) paidMinor!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 500) reason!: string;
}
