import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../../common/logging/app-logger.service';

export const NOTIFICATION_EMAIL_PROVIDER = Symbol('NOTIFICATION_EMAIL_PROVIDER');

export type NotificationEmailDeliveryStatus = 'disabled' | 'previewed' | 'sent';

export interface NotificationEmailMessage {
  category: string;
  html: string;
  subject: string;
  text: string;
  to: string;
}

export interface NotificationEmailProvider {
  send(
    message: NotificationEmailMessage,
  ): Promise<{ status: NotificationEmailDeliveryStatus }>;
}

@Injectable()
export class DisabledNotificationEmailProvider implements NotificationEmailProvider {
  async send(
    _message: NotificationEmailMessage,
  ): Promise<{ status: 'disabled' }> {
    return { status: 'disabled' };
  }
}

@Injectable()
export class PreviewNotificationEmailProvider implements NotificationEmailProvider {
  constructor(private readonly logger: AppLoggerService) {}

  async send(
    message: NotificationEmailMessage,
  ): Promise<{ status: 'previewed' }> {
    this.logger.log('notification_email_preview', 'NotificationEmailProvider', {
      category: message.category,
    });
    return { status: 'previewed' };
  }
}
