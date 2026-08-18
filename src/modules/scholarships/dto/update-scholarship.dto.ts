import { PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ScholarshipStatus } from '../../../../generated/prisma/client';
import { CreateScholarshipDto } from './create-scholarship.dto';

export class UpdateScholarshipDto extends PartialType(CreateScholarshipDto) {
  @IsOptional()
  @IsEnum(ScholarshipStatus)
  status?: ScholarshipStatus;
}
