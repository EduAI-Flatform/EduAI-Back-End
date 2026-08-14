import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProduces,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
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
import { NotificationStreamService } from './notification-stream.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationStreamService: NotificationStreamService,
  ) {}

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

  @Get('stream')
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Authenticated notification event stream.' })
  stream(
    @CurrentUser('id') userId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    return this.notificationStreamService.open(
      userId,
      response,
      parseLastEventId(lastEventId),
    );
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

function parseLastEventId(lastEventId: string | undefined): string | undefined {
  if (!lastEventId) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lastEventId)) {
    return lastEventId;
  }

  throw new BadRequestException('Last-Event-ID must be a UUID v4.');
}
