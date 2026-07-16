import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateCommunityCommentDto {
  @ApiProperty({ example: 'I would like to join the review session.' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Direct parent comment for a reply.' })
  @IsOptional()
  @IsUUID('4')
  parentId?: string;
}
