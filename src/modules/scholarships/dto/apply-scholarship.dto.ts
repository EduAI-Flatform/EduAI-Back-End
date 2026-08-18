import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ApplyScholarshipDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  courseId!: string;
}
