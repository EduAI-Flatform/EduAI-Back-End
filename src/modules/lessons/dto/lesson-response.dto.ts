import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LessonType } from '../../../../generated/prisma/client';

export class LessonDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Giới thiệu khóa học' })
  title!: string;

  @ApiProperty({ example: 'gioi-thieu-khoa-hoc' })
  slug!: string;

  @ApiProperty({ enum: LessonType })
  type!: LessonType;

  @ApiProperty({ minimum: 0 })
  orderIndex!: number;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  durationMinutes!: number | null;

  @ApiProperty()
  isPreview!: boolean;

  @ApiPropertyOptional({ nullable: true })
  content!: string | null;

  @ApiPropertyOptional({ nullable: true })
  videoUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  documentUrl!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
