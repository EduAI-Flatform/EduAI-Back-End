import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateLessonProgressDto {
  @ApiPropertyOptional({ description: 'Video seconds actually watched.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  watchedSeconds?: number;

  @ApiPropertyOptional({ description: 'Video duration in seconds.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'Last playback position in seconds.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  lastPositionSeconds?: number;

  @ApiPropertyOptional({
    description: 'Document/article viewing progress from 0 to 100.',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  documentProgressPercent?: number;
}
