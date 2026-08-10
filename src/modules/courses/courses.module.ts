import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CourseThumbnailStorageService } from './course-thumbnail-storage.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { LearningPathService } from './learning-path.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [CoursesController],
  providers: [CoursesService, CourseThumbnailStorageService, LearningPathService],
  exports: [CoursesService, LearningPathService],
})
export class CoursesModule {}
