import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = (value: unknown) => typeof value === 'string' ? value.trim() : value;

export class CreateMentorBookingDto {
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(300)
  topic!: string;
  @IsDateString()
  scheduledStart!: string;
  @IsDateString()
  scheduledEnd!: string;
}

export class RescheduleMentorBookingDto {
  @IsDateString()
  scheduledStart!: string;
  @IsDateString()
  scheduledEnd!: string;
}

export class MentorBookingReasonDto {
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class ListMentorBookingsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
}
