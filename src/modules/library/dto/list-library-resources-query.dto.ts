import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CourseVisibility } from '../../../../generated/prisma/enums';
import { LibraryResourceType } from './create-library-resource.dto';

export class ListLibraryResourcesQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ example: 'typescript' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  tagId?: string;

  @ApiPropertyOptional({ enum: LibraryResourceType })
  @IsOptional()
  @IsEnum(LibraryResourceType)
  type?: LibraryResourceType;

  @ApiPropertyOptional({ enum: CourseVisibility })
  @IsOptional()
  @IsEnum(CourseVisibility)
  visibility?: CourseVisibility;
}
