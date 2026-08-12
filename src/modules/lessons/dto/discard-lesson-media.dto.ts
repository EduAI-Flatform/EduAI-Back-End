import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class DiscardLessonMediaDto {
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  storageKey!: string;
}
