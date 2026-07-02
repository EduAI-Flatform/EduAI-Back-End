import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

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
    description: 'HTTPS URL from the approved file storage pipeline.',
    nullable: true,
  })
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  fileUrl?: string | null;
}
