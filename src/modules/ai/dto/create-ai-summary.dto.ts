import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

export class CreateAiSummaryDto {
  @ApiProperty({ enum: ['lesson', 'library_resource'] })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['lesson', 'library_resource'])
  sourceType!: 'lesson' | 'library_resource';

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  sourceId!: string;
}
