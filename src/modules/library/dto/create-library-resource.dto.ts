import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CourseVisibility } from '../../../../generated/prisma/enums';

export enum LibraryResourceType {
  pdf = 'pdf',
  docx = 'docx',
  pptx = 'pptx',
  video = 'video',
  image = 'image',
}

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function parseTagIds(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

export class CreateLibraryResourceDto {
  @ApiProperty({ example: 'Tài liệu TypeScript cơ bản' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiPropertyOptional({ example: 'Tài liệu nhập môn TypeScript.', nullable: true })
  @Transform(({ value }) => (value === '' ? null : trim(value)))
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  categoryId!: string;

  @ApiProperty({ enum: LibraryResourceType, example: LibraryResourceType.pdf })
  @IsEnum(LibraryResourceType)
  type!: LibraryResourceType;

  @ApiPropertyOptional({ enum: CourseVisibility, default: CourseVisibility.public })
  @IsOptional()
  @IsEnum(CourseVisibility)
  visibility?: CourseVisibility;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @Transform(({ value }) => parseTagIds(value))
  @IsOptional()
  @IsUUID('4', { each: true })
  tagIds?: string[];
}
