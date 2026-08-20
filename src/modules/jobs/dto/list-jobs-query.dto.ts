import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JOB_EMPLOYMENT_TYPES, JOB_WORK_MODES } from './create-job.dto';

function integer(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const result = Number(value);
  return Number.isInteger(result) ? result : value;
}

export class ListJobsQueryDto {
  @IsOptional() @Transform(({ value }) => integer(value)) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Transform(({ value }) => integer(value)) @IsInt() @Min(1) @Max(100)
  pageSize = 20;

  @IsOptional() @IsString() @MaxLength(120)
  search?: string;

  @IsOptional() @IsString() @MaxLength(160)
  location?: string;

  @IsOptional() @IsIn(JOB_WORK_MODES)
  workMode?: (typeof JOB_WORK_MODES)[number];

  @IsOptional() @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType?: (typeof JOB_EMPLOYMENT_TYPES)[number];

  @IsOptional() @IsIn(['draft', 'published', 'closed'])
  status?: 'draft' | 'published' | 'closed';
}
