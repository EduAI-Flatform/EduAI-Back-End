import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CourseThumbnailStorageService } from './course-thumbnail-storage.service';
import { CourseCompletionService } from './course-completion.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { LearningPathService } from './learning-path.service';

@Module({
  imports: [AuthModule, AuditModule, CertificatesModule, NotificationsModule],
  controllers: [CoursesController],
  providers: [
    CoursesService,
    CourseCompletionService,
    CourseThumbnailStorageService,
    LearningPathService,
  ],
  exports: [CoursesService, CourseCompletionService, LearningPathService],
})
export class CoursesModule {}
