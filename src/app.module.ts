import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { RedisModule } from './config/redis.module';
import { LoggingModule } from './common/logging/logging.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClassroomsModule } from './modules/classrooms/classrooms.module';
import { CoursesModule } from './modules/courses/courses.module';
import { HealthModule } from './modules/health/health.module';
import { LessonsModule } from './modules/lessons/lessons.module';
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
    LessonsModule,
    QuizzesModule,
    AssignmentsModule,
    ClassroomsModule,
  ],
})
export class AppModule {}
