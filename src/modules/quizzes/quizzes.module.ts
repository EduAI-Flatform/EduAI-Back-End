import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [AuthModule, AuditModule, CoursesModule, PlatformModule],
  controllers: [QuizzesController],
  providers: [QuizzesService],
  exports: [QuizzesService],
})
export class QuizzesModule {}
