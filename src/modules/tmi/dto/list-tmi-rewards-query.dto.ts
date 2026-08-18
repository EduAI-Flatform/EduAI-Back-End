import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TmiRewardStatus } from '../../../../generated/prisma/client';
function toInteger(value: unknown): unknown { if (value === undefined || value === null || value === '') return value; const parsed = Number(value); return Number.isInteger(parsed) ? parsed : value; }
export class ListTmiRewardsQueryDto {
  @IsOptional() @Transform(({ value }) => toInteger(value)) @IsInt() @Min(1) page = 1;
  @IsOptional() @Transform(({ value }) => toInteger(value)) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsEnum(TmiRewardStatus) status?: TmiRewardStatus;
}
