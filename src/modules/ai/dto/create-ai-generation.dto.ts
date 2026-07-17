import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CreateAiGenerationDto {
  @ApiProperty({ enum: ['lesson', 'library_resource'] })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['lesson', 'library_resource'])
  sourceType!: 'lesson' | 'library_resource';

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  sourceId!: string;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  count = 5;
}
