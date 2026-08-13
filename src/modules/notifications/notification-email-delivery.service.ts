import { Inject, Injectable } from '@nestjs/common';
import {
  EmailPurpose,
  NotificationChannel,
  NotificationDeliveryStatus,
} from '../../../generated/prisma/client';
import { AppLoggerService } from '../../common/logging/app-logger.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NOTIFICATION_EMAIL_PROVIDER,
  NotificationEmailMessage,
  NotificationEmailProvider,
} from './notification-email.provider';

@Injectable()
export class NotificationEmailDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_EMAIL_PROVIDER)
    private readonly provider: NotificationEmailProvider,
    private readonly logger: AppLoggerService,
  ) {}

  async deliver(notificationId: string): Promise<boolean> {
    const claimed = await this.prisma.notificationDelivery.updateMany({
      where: {
        notificationId,
        channel: NotificationChannel.email,
        status: {
          in: [NotificationDeliveryStatus.pending, NotificationDeliveryStatus.failed],
        },
      },
      data: {
        status: NotificationDeliveryStatus.processing,
        attemptedAt: new Date(),
        attemptCount: { increment: 1 },
        lastErrorCode: null,
      },
    });

    if (claimed.count === 0) return false;

    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: {
        notificationId_channel: {
          notificationId,
          channel: NotificationChannel.email,
        },
      },
      select: {
        id: true,
        emailPurpose: true,
        notification: {
          select: {
            category: true,
            title: true,
            body: true,
            user: { select: { email: true } },
          },
        },
      },
    });

    if (!delivery) {
      await this.prisma.notificationDelivery.updateMany({
        where: {
          notificationId,
          channel: NotificationChannel.email,
          status: NotificationDeliveryStatus.processing,
        },
        data: { status: NotificationDeliveryStatus.failed, lastErrorCode: 'delivery_not_found' },
      });
      this.logger.error('notification_email_delivery_missing', 'NotificationEmailDeliveryService');
      return false;
    }

    try {
      const result = await this.provider.send(
        this.createMessage(delivery.notification, delivery.emailPurpose),
      );
      if (result.status === 'disabled') {
        await this.markFailed(delivery.id, 'provider_disabled');
        this.logger.warn('notification_email_provider_disabled', 'NotificationEmailDeliveryService', {
          category: delivery.notification.category,
        });
        return false;
      }

      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.delivered,
          deliveredAt: new Date(),
          lastErrorCode: null,
        },
      });
      return true;
    } catch {
      await this.markFailed(delivery.id, 'provider_request_failed');
      this.logger.error('notification_email_delivery_failed', 'NotificationEmailDeliveryService', {
        category: delivery.notification.category,
      });
      return false;
    }
  }

  private markFailed(deliveryId: string, lastErrorCode: string): Promise<unknown> {
    return this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: NotificationDeliveryStatus.failed, lastErrorCode },
    });
  }

  private createMessage(notification: {
    category: string;
    title: string;
    body: string;
    user: { email: string };
  }, purpose: EmailPurpose | null): NotificationEmailMessage {
    const title = escapeHtml(notification.title);
    const body = escapeHtml(notification.body);
    const emailPurpose = purpose ?? EmailPurpose.optional;
    const subjectPrefix =
      emailPurpose === EmailPurpose.transactional ? 'EduAI action required:' : 'EduAI:';
    const heading =
      emailPurpose === EmailPurpose.transactional ? 'Action required' : 'EduAI notification';

    return {
      category: notification.category,
      purpose: emailPurpose,
      subject: `${subjectPrefix} ${notification.title}`,
      text: `${heading}\n\n${notification.title}\n\n${notification.body}`,
      html: `<h1>${heading}</h1><h2>${title}</h2><p>${body}</p>`,
      to: notification.user.email,
    };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
