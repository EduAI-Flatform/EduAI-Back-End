import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { MentorApprovalStatus } from '../../../../generated/prisma/client';

const trim = (value: unknown) => typeof value === 'string' ? value.trim() : value;

export class MentorAvailabilityDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(6)
  dayOfWeek!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(1439)
  startMinute!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(1440)
  endMinute!: number;
}

export class UpdateMentorProfileDto {
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(1) @MaxLength(160)
  headline!: string;
  @Transform(({ value }) => value === '' ? null : trim(value)) @IsOptional() @IsString() @MaxLength(2000)
  bio?: string | null;
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(1) @MaxLength(100)
  timezone!: string;
  @Transform(({ value }) => Array.isArray(value) ? value.map(trim) : value) @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(80, { each: true })
  expertise!: string[];
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => MentorAvailabilityDto)
  availability!: MentorAvailabilityDto[];
}

export class SetMentorActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

export class SetMentorApprovalDto {
  @IsIn([MentorApprovalStatus.approved, MentorApprovalStatus.rejected])
  status!: MentorApprovalStatus;
}

export class ListMentorsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MaxLength(120)
  search?: string;
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MaxLength(80)
  expertise?: string;
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MaxLength(100)
  timezone?: string;
  @IsOptional() @IsIn(Object.values(MentorApprovalStatus))
  status?: MentorApprovalStatus;
}
