import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubmissionStatus } from '../../../../generated/prisma/client';

class SubmissionStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Nguyễn Minh Anh' })
  fullName!: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl!: string | null;
}

export class SubmissionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  assignmentId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true })
  content!: string | null;

  @ApiPropertyOptional({ nullable: true })
  fileUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  fileName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  fileSize!: number | null;

  @ApiPropertyOptional({ nullable: true })
  fileMimeType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  score!: number | null;

  @ApiPropertyOptional({ nullable: true })
  feedback!: string | null;

  @ApiProperty({ enum: SubmissionStatus })
  status!: SubmissionStatus;

  @ApiProperty({ format: 'date-time' })
  submittedAt!: Date;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  gradedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  gradedById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: SubmissionStudentDto })
  student!: SubmissionStudentDto;

  @ApiProperty()
  isLate!: boolean;
}
