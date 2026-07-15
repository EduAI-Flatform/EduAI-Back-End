import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum CommunityPostVisibility {
  public = 'public',
  private = 'private',
}

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateCommunityPostDto {
  @ApiProperty({ example: 'Study group for AI foundations' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @ApiProperty({ example: 'Does anyone want to review the first lesson together?' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;

  @ApiPropertyOptional({ enum: CommunityPostVisibility, default: CommunityPostVisibility.public })
  @IsOptional()
  @IsEnum(CommunityPostVisibility)
  visibility?: CommunityPostVisibility;
}
