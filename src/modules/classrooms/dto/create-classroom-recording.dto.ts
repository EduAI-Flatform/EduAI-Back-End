import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUrl, Max, MaxLength, Min } from 'class-validator';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateClassroomRecordingDto {
  @ApiProperty({ format: 'uri' })
  @Transform(({ value }) => trimString(value))
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  recordingUrl!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 86400 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  durationSeconds?: number;
}
