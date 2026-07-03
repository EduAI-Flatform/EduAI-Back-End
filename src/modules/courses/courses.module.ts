import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';
import { QuizAttemptsController } from './quiz-attempts.controller';
import { QuizAttemptsService } from './quiz-attempts.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

@Module({
  imports: [AuthModule],
  controllers: [
    CoursesController,
    LessonsController,
    QuizzesController,
    QuizAttemptsController,
    AssignmentsController,
  ],
  providers: [
    CoursesService,
    LessonsService,
    QuizzesService,
    QuizAttemptsService,
    AssignmentsService,
  ],
  exports: [
    CoursesService,
    LessonsService,
    QuizzesService,
    QuizAttemptsService,
    AssignmentsService,
  ],
})
export class CoursesModule {}
