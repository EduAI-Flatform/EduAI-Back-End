import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationEmailDeliveryService } from './notification-email-delivery.service';

export { NotificationCategory, NotificationChannel };

export interface CreateNotificationInput {
  userId: string;
  eventKey: string;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  link?: string;
}

export interface ListNotificationsQuery {
  page: number;
  pageSize: number;
  unreadOnly?: boolean;
}

const notificationSelect = {
  id: true,
  type: true,
  category: true,
  title: true,
  body: true,
  link: true,
  isRead: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

const notificationPreferenceSelect = {
  channel: true,
  category: true,
  isEnabled: true,
} satisfies Prisma.NotificationPreferenceSelect;

type NotificationResponse = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;

export type NotificationPreferenceResponse = Prisma.NotificationPreferenceGetPayload<{
  select: typeof notificationPreferenceSelect;
}>;

export interface PaginatedNotificationsResponse {
  items: NotificationResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const preferenceCategories = [
  NotificationCategory.system,
  NotificationCategory.assignment,
  NotificationCategory.grade,
  NotificationCategory.classroom,
  NotificationCategory.certificate,
] as const;

const preferenceChannels = [
  NotificationChannel.in_app,
  NotificationChannel.email,
] as const;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly emailDeliveryService?: NotificationEmailDeliveryService,
  ) {}

  async createForUser(input: CreateNotificationInput): Promise<NotificationResponse> {
    const [inAppEnabled, emailEnabled] = await Promise.all([
      this.isDeliveryEnabled(input.userId, NotificationChannel.in_app, input.category),
      this.isDeliveryEnabled(input.userId, NotificationChannel.email, input.category),
    ]);

    const notification = await this.prisma.notification.upsert({
      where: {
        userId_eventKey: {
          userId: input.userId,
          eventKey: input.eventKey,
        },
      },
      create: {
        userId: input.userId,
        eventKey: input.eventKey,
        type: input.type,
        category: input.category,
        title: input.title,
        body: input.body,
        ...(input.link ? { link: input.link } : {}),
        ...((inAppEnabled || emailEnabled)
          ? {
              deliveries: {
                create: [
                  ...(inAppEnabled
                    ? [
                        {
                          channel: NotificationChannel.in_app,
                          status: NotificationDeliveryStatus.delivered,
                          deliveredAt: new Date(),
                        },
                      ]
                    : []),
                  ...(emailEnabled
                    ? [
                        {
                          channel: NotificationChannel.email,
                          status: NotificationDeliveryStatus.pending,
                        },
                      ]
                    : []),
                ],
              },
            }
          : {}),
      },
      update: {},
      select: notificationSelect,
    });

    if (emailEnabled && this.emailDeliveryService) {
      void this.emailDeliveryService.deliver(notification.id).catch(() => undefined);
    }

    return notification;
  }

  async listForUser(
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<PaginatedNotificationsResponse> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: notificationSelect,
      }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markAsRead(userId: string, notificationId: string): Promise<NotificationResponse> {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: notificationSelect,
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.isRead) return notification;

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true, readAt: new Date() },
      select: notificationSelect,
    });
  }

  async markAllAsRead(userId: string): Promise<{ updatedCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updatedCount: result.count };
  }

  async getPreferences(userId: string): Promise<NotificationPreferenceResponse[]> {
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { userId },
      select: notificationPreferenceSelect,
    });
    const saved = new Map(
      preferences.map((preference) => [
        `${preference.channel}:${preference.category}`,
        preference.isEnabled,
      ]),
    );

    return preferenceChannels.flatMap((channel) =>
      preferenceCategories.map((category) => ({
        channel,
        category,
        isEnabled:
          saved.get(`${channel}:${category}`) ??
          this.defaultPreference(channel),
      })),
    );
  }

  setPreference(
    userId: string,
    channel: NotificationChannel,
    category: NotificationCategory,
    isEnabled: boolean,
  ): Promise<NotificationPreferenceResponse> {
    return this.prisma.notificationPreference.upsert({
      where: { userId_channel_category: { userId, channel, category } },
      create: { userId, channel, category, isEnabled },
      update: { isEnabled },
      select: notificationPreferenceSelect,
    });
  }

  private async isDeliveryEnabled(
    userId: string,
    channel: NotificationChannel,
    category: NotificationCategory,
  ): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId_channel_category: { userId, channel, category } },
      select: { isEnabled: true },
    });
    return preference?.isEnabled ?? this.defaultPreference(channel);
  }

  private defaultPreference(channel: NotificationChannel): boolean {
    return channel === NotificationChannel.in_app;
  }
}
