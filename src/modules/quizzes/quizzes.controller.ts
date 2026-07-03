import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateQuizDto } from './dto/create-quiz.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { UpdateQuizDto } from './dto/update-quiz.dto';
import {
  DeletedQuestionResponse,
  DeletedQuizResponse,
  QuestionResponse,
  QuizAttemptResponse,
  QuizResponse,
  QuizzesService,
} from './quizzes.service';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';

@ApiTags('Quizzes')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required.' })
@ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.instructor, RoleName.platform_admin)
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  @Post('courses/:courseId/quizzes')
  @ApiCreatedResponse({ description: 'Draft quiz created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid course id or quiz payload.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Owned course or lesson not found.' })
  createQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() input: CreateQuizDto,
  ): Promise<QuizResponse> {
    return this.quizzesService.createQuiz(user, courseId, input);
  }

  @Get('courses/:courseId/quizzes')
  @ApiOkResponse({ description: 'Owned course quizzes returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'Instructor or admin role required.' })
  @ApiNotFoundResponse({ description: 'Owned course not found.' })
  listQuizzes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
  ): Promise<QuizResponse[]> {
    return this.quizzesService.listQuizzes(user, courseId);
  }

  @Get('quizzes/:id')
  @ApiOkResponse({ description: 'Owned quiz returned successfully.' })
  @ApiNotFoundResponse({ description: 'Owned quiz not found.' })
  getQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<QuizResponse> {
    return this.quizzesService.getQuiz(user, quizId);
  }

  @Put('quizzes/:id')
  @ApiOkResponse({ description: 'Owned quiz updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid quiz id or payload.' })
  @ApiNotFoundResponse({ description: 'Owned quiz or lesson not found.' })
  updateQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) quizId: string,
    @Body() input: UpdateQuizDto,
  ): Promise<QuizResponse> {
    return this.quizzesService.updateQuiz(user, quizId, input);
  }

  @Delete('quizzes/:id')
  @ApiOkResponse({ description: 'Owned quiz deleted successfully.' })
  @ApiNotFoundResponse({ description: 'Owned quiz not found.' })
  deleteQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<DeletedQuizResponse> {
    return this.quizzesService.deleteQuiz(user, quizId);
  }

  @Post('quizzes/:id/publish')
  @ApiOkResponse({ description: 'Owned quiz published successfully.' })
  @ApiNotFoundResponse({ description: 'Owned quiz not found.' })
  publishQuiz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<QuizResponse> {
    return this.quizzesService.publishQuiz(user, quizId);
  }

  @Post('quizzes/:quizId/questions')
  @ApiCreatedResponse({ description: 'Quiz question created successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid quiz id or question payload.' })
  @ApiConflictResponse({ description: 'Question order index already exists.' })
  @ApiNotFoundResponse({ description: 'Owned quiz not found.' })
  createQuestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
    @Body() input: CreateQuestionDto,
  ): Promise<QuestionResponse> {
    return this.quizzesService.createQuestion(user, quizId, input);
  }

  @Get('quizzes/:quizId/questions')
  @ApiOkResponse({ description: 'Owned quiz questions returned successfully.' })
  @ApiNotFoundResponse({ description: 'Owned quiz not found.' })
  listQuestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<QuestionResponse[]> {
    return this.quizzesService.listQuestions(user, quizId);
  }

  @Put('questions/:id')
  @ApiOkResponse({ description: 'Quiz question updated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid question id or payload.' })
  @ApiConflictResponse({ description: 'Question order index already exists.' })
  @ApiNotFoundResponse({ description: 'Owned question not found.' })
  updateQuestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) questionId: string,
    @Body() input: UpdateQuestionDto,
  ): Promise<QuestionResponse> {
    return this.quizzesService.updateQuestion(user, questionId, input);
  }

  @Delete('questions/:id')
  @ApiOkResponse({ description: 'Quiz question deleted successfully.' })
  @ApiNotFoundResponse({ description: 'Owned question not found.' })
  deleteQuestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) questionId: string,
  ): Promise<DeletedQuestionResponse> {
    return this.quizzesService.deleteQuestion(user, questionId);
  }

  @Post('quizzes/:quizId/attempts')
  @Roles(RoleName.student)
  @ApiCreatedResponse({ description: 'Quiz attempt scored and stored.' })
  @ApiBadRequestResponse({ description: 'Invalid or incomplete answer set.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  @ApiNotFoundResponse({
    description: 'Published quiz or student enrollment not found.',
  })
  submitAttempt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
    @Body() input: SubmitQuizAttemptDto,
  ): Promise<QuizAttemptResponse> {
    return this.quizzesService.submitAttempt(user.id, quizId, input);
  }

  @Get('quizzes/:quizId/attempts/me')
  @Roles(RoleName.student)
  @ApiOkResponse({ description: 'Current student quiz attempts returned.' })
  @ApiForbiddenResponse({ description: 'Student role required.' })
  listMyAttempts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quizId', new ParseUUIDPipe({ version: '4' })) quizId: string,
  ): Promise<QuizAttemptResponse[]> {
    return this.quizzesService.listMyAttempts(user.id, quizId);
  }
}
