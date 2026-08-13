import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../../common/logging/app-logger.service';
import { AppConfigService } from '../../config/app-config.service';

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

export function resolveNotificationEmailProvider(
  appConfig: AppConfigService,
  disabled: DisabledNotificationEmailProvider,
  preview: PreviewNotificationEmailProvider,
  resend: ResendNotificationEmailProvider,
): NotificationEmailProvider {
  if (appConfig.email.provider === 'preview') return preview;
  if (appConfig.email.provider === 'resend') return resend;
  return disabled;
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

@Injectable()
export class ResendNotificationEmailProvider implements NotificationEmailProvider {
  constructor(private readonly appConfig: AppConfigService) {}

  async send(
    message: NotificationEmailMessage,
  ): Promise<{ status: 'sent' }> {
    const { from, resendApiKey } = this.appConfig.email;

    if (!from || !resendApiKey) {
      throw new Error('Notification email provider is not configured');
    }

    const response = await fetch('https://api.resend.com/emails', {
      body: JSON.stringify({
        from,
        html: message.html,
        subject: message.subject,
        text: message.text,
        to: [message.to],
      }),
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error('Notification email provider request failed');
    }

    return { status: 'sent' };
  }
}
