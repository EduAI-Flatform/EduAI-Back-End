import { ApiProperty } from '@nestjs/swagger';
import { NotificationCategory, NotificationChannel } from '../../../../generated/prisma/client';
import { IsBoolean, IsEnum } from 'class-validator';

export class UpdateNotificationPreferenceDto {
  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @ApiProperty({ enum: NotificationCategory })
  @IsEnum(NotificationCategory)
  category!: NotificationCategory;

  @ApiProperty({ example: true })
  @IsBoolean()
  isEnabled!: boolean;
}
