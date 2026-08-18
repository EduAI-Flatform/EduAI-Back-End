import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ScholarshipApplicationStatus,
  ScholarshipStatus,
} from '../../../../generated/prisma/client';

function toInteger(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

export class ListScholarshipsQueryDto {
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

  @IsOptional()
  @IsEnum(ScholarshipStatus)
  status?: ScholarshipStatus;

  @IsOptional()
  @IsEnum(ScholarshipApplicationStatus)
  applicationStatus?: ScholarshipApplicationStatus;
}
