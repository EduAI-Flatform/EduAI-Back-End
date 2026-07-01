import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { InstructorCoursesController } from './instructor-courses.controller';
import { LearningProgressController } from './learning-progress.controller';
import { LearningProgressService } from './learning-progress.service';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';

@Module({
  imports: [AuthModule],
  controllers: [
    CoursesController,
    InstructorCoursesController,
    LessonsController,
    EnrollmentsController,
    LearningProgressController,
  ],
  providers: [
    CoursesService,
    LessonsService,
    EnrollmentsService,
    LearningProgressService,
  ],
  exports: [
    CoursesService,
    LessonsService,
    EnrollmentsService,
    LearningProgressService,
  ],
})
export class CoursesModule {}
