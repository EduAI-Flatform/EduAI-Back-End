import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { RedisModule } from './config/redis.module';
import { LoggingModule } from './common/logging/logging.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClassroomsModule } from './modules/classrooms/classrooms.module';
import { CommunityModule } from './modules/community/community.module';
import { CoursesModule } from './modules/courses/courses.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { HealthModule } from './modules/health/health.module';
import { LessonsModule } from './modules/lessons/lessons.module';
import { LibraryModule } from './modules/library/library.module';
import { ProfileModule } from './modules/profile/profile.module';
import { QuizzesModule } from './modules/quizzes/quizzes.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    ProfileModule,
    CoursesModule,
    CertificatesModule,
    LessonsModule,
    LibraryModule,
    QuizzesModule,
    AssignmentsModule,
    ClassroomsModule,
    CommunityModule,
    AiModule,
  ],
})
export class AppModule {}
