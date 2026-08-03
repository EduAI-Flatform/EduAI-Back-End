import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AiSourceResponseDto {
  @ApiProperty({ enum: ['lesson', 'library_resource'] })
  sourceType!: 'lesson' | 'library_resource';

  @ApiProperty({ format: 'uuid' })
  sourceId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  courseId?: string;
}
