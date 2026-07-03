import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';

@Module({
  imports: [AuthModule],
  controllers: [QuizzesController],
  providers: [QuizzesService],
  exports: [QuizzesService],
})
export class QuizzesModule {}
