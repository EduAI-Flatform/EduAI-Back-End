import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export type AiSourceType = 'lesson' | 'library_resource';

export class ListAiSourcesQueryDto {
  @ApiPropertyOptional({ enum: ['lesson', 'library_resource'] })
  @IsOptional()
  @IsIn(['lesson', 'library_resource'])
  sourceType?: AiSourceType;

  @ApiPropertyOptional({ example: 'gradient descent', maxLength: 120 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
