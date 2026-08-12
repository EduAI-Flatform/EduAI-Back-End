import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_VIDEO_UPLOAD_SIZE_BYTES, VIDEO_MIME_TYPES } from '../lesson-media-storage.service';

export class FinalizeVideoUploadDto {
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  storageKey!: string;

  @ApiProperty({ enum: VIDEO_MIME_TYPES })
  @IsIn(VIDEO_MIME_TYPES)
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_VIDEO_UPLOAD_SIZE_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_UPLOAD_SIZE_BYTES)
  size!: number;
}
