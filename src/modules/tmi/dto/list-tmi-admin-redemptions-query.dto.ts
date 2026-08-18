import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

function toInteger(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

export class ListTmiAdminRedemptionsQueryDto {
  @IsOptional() @Transform(({ value }) => toInteger(value)) @IsInt() @Min(1) page = 1;
  @IsOptional() @Transform(({ value }) => toInteger(value)) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() rewardId?: string;
}
