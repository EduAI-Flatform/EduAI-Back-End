import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { RedisModule } from './config/redis.module';
import { LoggingModule } from './common/logging/logging.module';
import { AuditModule } from './common/audit/audit.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClassroomsModule } from './modules/classrooms/classrooms.module';
import { CommunityModule } from './modules/community/community.module';
import { CoursesModule } from './modules/courses/courses.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { DashboardsModule } from './modules/dashboards/dashboards.module';
import { HealthModule } from './modules/health/health.module';
import { LessonsModule } from './modules/lessons/lessons.module';
import { LibraryModule } from './modules/library/library.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProfileModule } from './modules/profile/profile.module';
import { QuizzesModule } from './modules/quizzes/quizzes.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { ScholarshipsModule } from './modules/scholarships/scholarships.module';
import { TmiModule } from './modules/tmi/tmi.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MentorsModule } from './modules/mentors/mentors.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    AuditModule,
    RedisModule,
    HealthModule,
    AuthModule,
    AdminModule,
    ProfileModule,
    CoursesModule,
    CertificatesModule,
    DashboardsModule,
    LessonsModule,
    LibraryModule,
    ModerationModule,
    MediaModule,
    NotificationsModule,
    QuizzesModule,
    AssignmentsModule,
    ClassroomsModule,
    CommunityModule,
    AiModule,
    VouchersModule,
    ScholarshipsModule,
    TmiModule,
    JobsModule,
    MentorsModule,
  ],
})
export class AppModule {}
