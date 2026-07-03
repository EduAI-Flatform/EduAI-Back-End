import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';
import {
  QuizAttemptResponse,
  QuizAttemptsService,
} from './quiz-attempts.service';

@ApiTags('Quiz Attempts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Student role required.' })
@Controller('quizzes/:quizId/attempts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class QuizAttemptsController {
  constructor(private readonly quizAttemptsService: QuizAttemptsService) {}

  @Post()
  @ApiCreatedResponse({ description: 'Quiz attempt scored and stored.' })
  @ApiBadRequestResponse({ description: 'Invalid or incomplete answer set.' })
  @ApiNotFoundResponse({
    description: 'Published quiz or student enrollment not found.',
  })
  submitAttempt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
    @Body() input: SubmitQuizAttemptDto,
  ): Promise<QuizAttemptResponse> {
    return this.quizAttemptsService.submitAttempt(user.id, quizId, input);
  }

  @Get('me')
  @ApiOkResponse({ description: 'Current student quiz attempts returned.' })
  listMyAttempts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<QuizAttemptResponse[]> {
    return this.quizAttemptsService.listMyAttempts(user.id, quizId);
  }
}
