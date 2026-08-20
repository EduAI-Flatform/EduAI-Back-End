import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MentorsController } from './mentors.controller';
import { MentorsService } from './mentors.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MentorBookingsController } from './mentor-bookings.controller';
import { MentorBookingsService } from './mentor-bookings.service';

@Module({ imports: [PrismaModule, AuthModule, AuditModule, NotificationsModule], controllers: [MentorsController, MentorBookingsController], providers: [MentorsService, MentorBookingsService], exports: [MentorsService, MentorBookingsService] })
export class MentorsModule {}
