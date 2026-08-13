import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsController } from './notifications.controller';
import {
  DisabledNotificationEmailProvider,
  NOTIFICATION_EMAIL_PROVIDER,
  PreviewNotificationEmailProvider,
  ResendNotificationEmailProvider,
  resolveNotificationEmailProvider,
} from './notification-email.provider';
import { NotificationEmailDeliveryService } from './notification-email-delivery.service';
import { NotificationsService } from './notifications.service';

const notificationEmailProvider = {
  provide: NOTIFICATION_EMAIL_PROVIDER,
  inject: [
    AppConfigService,
    DisabledNotificationEmailProvider,
    PreviewNotificationEmailProvider,
    ResendNotificationEmailProvider,
  ],
  useFactory: resolveNotificationEmailProvider,
};

@Module({
  imports: [AppConfigModule, AuthModule, PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationEmailDeliveryService,
    DisabledNotificationEmailProvider,
    PreviewNotificationEmailProvider,
    ResendNotificationEmailProvider,
    notificationEmailProvider,
  ],
  exports: [NotificationsService, NOTIFICATION_EMAIL_PROVIDER],
})
export class NotificationsModule {}
