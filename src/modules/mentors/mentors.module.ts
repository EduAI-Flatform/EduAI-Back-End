import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MentorsController } from './mentors.controller';
import { MentorsService } from './mentors.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MentorBookingsController } from './mentor-bookings.controller';
import { MentorBookingsService } from './mentor-bookings.service';
import { ClassroomsModule } from '../classrooms/classrooms.module';
import { MentorSessionsController } from './mentor-sessions.controller';
import { MentorSessionsService } from './mentor-sessions.service';
import { MentorOutcomesController } from './mentor-outcomes.controller';
import { MentorOutcomesService } from './mentor-outcomes.service';

@Module({ imports: [PrismaModule, AuthModule, AuditModule, NotificationsModule, ClassroomsModule], controllers: [MentorsController, MentorBookingsController, MentorSessionsController, MentorOutcomesController], providers: [MentorsService, MentorBookingsService, MentorSessionsService, MentorOutcomesService], exports: [MentorsService, MentorBookingsService, MentorSessionsService, MentorOutcomesService] })
export class MentorsModule {}
