import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { LessonMediaStorageService } from './lesson-media-storage.service';

@Module({
  imports: [AuthModule, CoursesModule],
  controllers: [LessonsController],
  providers: [LessonMediaStorageService, LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
