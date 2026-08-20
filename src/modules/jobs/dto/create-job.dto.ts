import { Type, Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const JOB_WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export const JOB_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'internship', 'contract'] as const;

function trim(value: unknown): unknown { return typeof value === 'string' ? value.trim() : value; }

export class JobRequiredSkillDto {
  @ApiProperty({ example: 'TypeScript' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'advanced', nullable: true })
  @Transform(({ value }) => value === '' ? null : trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(40)
  level?: string | null;
}

export class CreateJobDto {
  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  companyName!: string;

  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @ApiProperty()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  description!: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => value === '' ? null : trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(160)
  location?: string | null;

  @ApiProperty({ enum: JOB_WORK_MODES })
  @IsIn(JOB_WORK_MODES)
  workMode!: (typeof JOB_WORK_MODES)[number];

  @ApiProperty({ enum: JOB_EMPLOYMENT_TYPES })
  @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType!: (typeof JOB_EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  salaryMin?: number | null;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  salaryMax?: number | null;

  @ApiPropertyOptional({ example: 'VND', nullable: true })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsOptional()
  @IsString()
  @MaxLength(3)
  salaryCurrency?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  closesAt?: string | null;

  @ApiProperty({ type: [JobRequiredSkillDto] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => JobRequiredSkillDto)
  requiredSkills!: JobRequiredSkillDto[];
}
