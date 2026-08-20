import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JobApplicationStatus } from '../../../../generated/prisma/client';

export class ApplyToJobDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() || null : value)
  @IsOptional() @IsString() @MaxLength(5000)
  coverLetter?: string | null;
}

export class UpdateJobApplicationStatusDto {
  @IsIn([JobApplicationStatus.reviewing, JobApplicationStatus.shortlisted, JobApplicationStatus.accepted, JobApplicationStatus.rejected])
  status!: JobApplicationStatus;
}

export class ListJobApplicationsQueryDto {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1)
  page = 1;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
  @IsOptional() @IsIn(Object.values(JobApplicationStatus))
  status?: JobApplicationStatus;
}
