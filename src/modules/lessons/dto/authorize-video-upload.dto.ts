import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_VIDEO_UPLOAD_SIZE_BYTES, VIDEO_MIME_TYPES } from '../lesson-media-storage.service';

export class AuthorizeVideoUploadDto {
  @ApiProperty({ enum: VIDEO_MIME_TYPES, example: 'video/mp4' })
  @IsIn(VIDEO_MIME_TYPES)
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_VIDEO_UPLOAD_SIZE_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_UPLOAD_SIZE_BYTES)
  size!: number;
}
