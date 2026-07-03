import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QuizAttemptsController } from './quiz-attempts.controller';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';

@Module({
  imports: [AuthModule],
  controllers: [QuizzesController, QuizAttemptsController],
  providers: [QuizzesService, QuizAttemptsService],
  exports: [QuizzesService, QuizAttemptsService],
})
export class QuizzesModule {}
