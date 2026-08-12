import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class SubmitAssignmentDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 50000 })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  content?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uri',
    deprecated: true,
    description: 'External file URLs are rejected; upload a multipart file instead.',
  })
  @IsEmpty({ message: 'fileUrl is not accepted; upload a file instead' })
  fileUrl?: never;

}
