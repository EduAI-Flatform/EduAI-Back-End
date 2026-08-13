import { NotFoundException } from '@nestjs/common';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationsService,
} from './notifications.service';

const userId = '0e56a921-d211-4b4d-a869-20338624d0fb';
const notificationId = '13aa8a9b-8fe5-4ec0-9ac8-b6f2a2ad29aa';

const notification = {
  id: notificationId,
  type: 'assignment_graded',
  category: NotificationCategory.assignment,
  title: 'Assignment graded',
  body: 'Your assignment has been graded.',
  link: '/assignments/assignment-id/submissions/me',
  isRead: false,
  readAt: null,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
};

function createService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    $transaction: jest.fn().mockResolvedValue([1, [notification]]),
    notification: {
      upsert: jest.fn().mockResolvedValue(notification),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(notification),
      update: jest.fn().mockResolvedValue({ ...notification, isRead: true }),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(1),
    },
    notificationPreference: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    ...overrides,
  };

  return {
    prisma,
    service: new NotificationsService(prisma as never),
  };
}

describe('NotificationsService.createForUser', () => {
  it('deduplicates a recipient event key and creates only an in-app delivery', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createForUser({
        userId,
        eventKey: 'assignment:submission-id:graded',
        type: 'assignment_graded',
        category: NotificationCategory.assignment,
        title: notification.title,
        body: notification.body,
        link: notification.link,
      }),
    ).resolves.toEqual(notification);

    expect(prisma.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_eventKey: {
            userId,
            eventKey: 'assignment:submission-id:graded',
          },
        },
        create: expect.objectContaining({
          userId,
          eventKey: 'assignment:submission-id:graded',
          deliveries: {
            create: expect.objectContaining({
              channel: NotificationChannel.in_app,
              status: 'delivered',
            }),
          },
        }),
        update: {},
      }),
    );
  });
});

describe('NotificationsService.listForUser', () => {
  it('uses the authenticated user scope, unread filter, bounded pagination, and a lean projection', async () => {
    const { prisma, service } = createService();

    await expect(
      service.listForUser(userId, { page: 2, pageSize: 25, unreadOnly: true }),
    ).resolves.toEqual({
      items: [notification],
      page: 2,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });

    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId, isRead: false },
    });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId, isRead: false },
        skip: 25,
        take: 25,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: expect.objectContaining({
          id: true,
          title: true,
          isRead: true,
          createdAt: true,
        }),
      }),
    );
  });
});

describe('NotificationsService.markAsRead', () => {
  it('does not expose or modify a notification owned by another user', async () => {
    const { prisma, service } = createService({
      notification: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });

    await expect(service.markAsRead(userId, notificationId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: notificationId, userId } }),
    );
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('keeps an already-read notification idempotent', async () => {
    const alreadyRead = { ...notification, isRead: true, readAt: new Date() };
    const { prisma, service } = createService({
      notification: {
        findFirst: jest.fn().mockResolvedValue(alreadyRead),
        update: jest.fn(),
      },
    });

    await expect(service.markAsRead(userId, notificationId)).resolves.toEqual(
      alreadyRead,
    );
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.getPreferences', () => {
  it('returns safe defaults when a user has not customized delivery preferences', async () => {
    const { service } = createService();

    await expect(service.getPreferences(userId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: NotificationChannel.in_app,
          category: NotificationCategory.system,
          isEnabled: true,
        }),
        expect.objectContaining({
          channel: NotificationChannel.email,
          category: NotificationCategory.system,
          isEnabled: false,
        }),
      ]),
    );
  });
});
