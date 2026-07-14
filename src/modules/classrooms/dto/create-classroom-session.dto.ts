import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateClassroomSessionDto {
  @ApiProperty({ example: 'Live Q&A: Introduction to AI' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  scheduledStart!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  scheduledEnd!: string;
}
