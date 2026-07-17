import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class IssueCertificateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  courseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  certificateTemplateId!: string;
}
