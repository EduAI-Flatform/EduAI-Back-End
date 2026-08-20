import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MentorGoalStatus } from '../../../../generated/prisma/client';

const trim = (value: unknown) => typeof value === 'string' ? value.trim() : value;
export class MentorNoteDto { @Transform(({ value }) => trim(value)) @IsString() @MinLength(1) @MaxLength(5000) content!: string }
export class CreateMentorGoalDto { @Transform(({ value }) => trim(value)) @IsString() @MinLength(1) @MaxLength(500) content!: string }
export class UpdateMentorGoalDto { @IsIn([MentorGoalStatus.open, MentorGoalStatus.completed]) status!: MentorGoalStatus }
export class MentorReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MaxLength(2000) comment?: string;
}
