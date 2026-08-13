import { Controller, Get, Param, ParseUUIDPipe, Patch, Put, Query, UseGuards, Body } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  MarkAllNotificationsReadResponseDto,
  NotificationPreferenceResponseDto,
  NotificationResponseDto,
  PaginatedNotificationsResponseDto,
  UnreadNotificationCountResponseDto,
} from './dto/notification-response.dto';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';
import {
  NotificationPreferenceResponse,
  NotificationsService,
  PaginatedNotificationsResponse,
} from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedNotificationsResponseDto })
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedNotificationsResponse> {
    return this.notificationsService.listForUser(userId, query);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadNotificationCountResponseDto })
  async unreadCount(@CurrentUser('id') userId: string): Promise<{ unreadCount: number }> {
    return { unreadCount: await this.notificationsService.unreadCount(userId) };
  }

  @Patch('read-all')
  @ApiOkResponse({ type: MarkAllNotificationsReadResponseDto })
  markAllAsRead(
    @CurrentUser('id') userId: string,
  ): Promise<{ updatedCount: number }> {
    return this.notificationsService.markAllAsRead(userId);
  }

  @Get('preferences')
  @ApiOkResponse({ type: NotificationPreferenceResponseDto, isArray: true })
  getPreferences(
    @CurrentUser('id') userId: string,
  ): Promise<NotificationPreferenceResponse[]> {
    return this.notificationsService.getPreferences(userId);
  }

  @Put('preferences')
  @ApiOkResponse({ type: NotificationPreferenceResponseDto })
  setPreference(
    @CurrentUser('id') userId: string,
    @Body() input: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreferenceResponse> {
    return this.notificationsService.setPreference(
      userId,
      input.channel,
      input.category,
      input.isEnabled,
    );
  }

  @Patch(':notificationId/read')
  @ApiOkResponse({ type: NotificationResponseDto })
  @ApiNotFoundResponse({ description: 'Notification not found.' })
  markAsRead(
    @CurrentUser('id') userId: string,
    @Param('notificationId', new ParseUUIDPipe({ version: '4' })) notificationId: string,
  ) {
    return this.notificationsService.markAsRead(userId, notificationId);
  }
}
