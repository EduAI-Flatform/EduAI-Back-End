import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

function toInteger(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

export class ListVouchersQueryDto {
  @IsOptional()
  @Transform(({ value }) => toInteger(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => toInteger(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
