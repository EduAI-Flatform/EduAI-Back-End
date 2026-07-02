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
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';

@Module({
  imports: [AuthModule],
  controllers: [
    CoursesController,
    InstructorCoursesController,
    LessonsController,
    EnrollmentsController,
    LearningProgressController,
    QuizzesController,
  ],
  providers: [
    CoursesService,
    LessonsService,
    EnrollmentsService,
    LearningProgressService,
    QuizzesService,
  ],
  exports: [
    CoursesService,
    LessonsService,
    EnrollmentsService,
    LearningProgressService,
    QuizzesService,
  ],
})
export class CoursesModule {}
