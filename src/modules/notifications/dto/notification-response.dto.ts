import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationCategory, NotificationChannel } from '../../../../generated/prisma/client';

export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'assignment_graded' })
  type!: string;

  @ApiProperty({ enum: NotificationCategory })
  category!: NotificationCategory;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiPropertyOptional({ example: '/assignments/assignment-id/submissions/me' })
  link!: string | null;

  @ApiProperty()
  isRead!: boolean;

  @ApiPropertyOptional({ format: 'date-time' })
  readAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PaginatedNotificationsResponseDto {
  @ApiProperty({ type: [NotificationResponseDto] })
  items!: NotificationResponseDto[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 0 })
  totalPages!: number;
}

export class UnreadNotificationCountResponseDto {
  @ApiProperty({ minimum: 0 })
  unreadCount!: number;
}

export class MarkAllNotificationsReadResponseDto {
  @ApiProperty({ minimum: 0 })
  updatedCount!: number;
}

export class NotificationPreferenceResponseDto {
  @ApiProperty({ enum: NotificationChannel })
  channel!: NotificationChannel;

  @ApiProperty({ enum: NotificationCategory })
  category!: NotificationCategory;

  @ApiProperty()
  isEnabled!: boolean;
}
