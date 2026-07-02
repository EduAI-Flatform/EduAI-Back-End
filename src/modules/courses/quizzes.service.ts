import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  QuizStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateQuizDto } from './dto/create-quiz.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { UpdateQuizDto } from './dto/update-quiz.dto';

const quizResponseSelect = {
  id: true,
  courseId: true,
  lessonId: true,
  title: true,
  description: true,
  passingScore: true,
  timeLimitMinutes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuizSelect;

const questionResponseSelect = {
  id: true,
  quizId: true,
  type: true,
  questionText: true,
  optionsJson: true,
  correctAnswerJson: true,
  explanation: true,
  points: true,
  orderIndex: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuestionSelect;

export type QuizResponse = Prisma.QuizGetPayload<{
  select: typeof quizResponseSelect;
}>;

export type QuestionResponse = Prisma.QuestionGetPayload<{
  select: typeof questionResponseSelect;
}>;

export interface DeletedQuizResponse {
  deleted: true;
}

export interface DeletedQuestionResponse {
  deleted: true;
}

type ManageableQuiz = QuizResponse & {
  course: { instructorId: string };
};

type ManageableQuestion = QuestionResponse & {
  quiz: { course: { instructorId: string } };
};

@Injectable()
export class QuizzesService {
  constructor(private readonly prisma: PrismaService) {}

  async createQuiz(
    user: AuthenticatedUser,
    courseId: string,
    input: CreateQuizDto,
  ): Promise<QuizResponse> {
    await this.findManageableCourseOrThrow(user, courseId);
    await this.assertLessonBelongsToCourse(input.lessonId, courseId);

    return this.prisma.quiz.create({
      data: {
        courseId,
        lessonId: input.lessonId,
        title: input.title,
        description: input.description,
        passingScore: input.passingScore,
        timeLimitMinutes: input.timeLimitMinutes,
        status: QuizStatus.draft,
      },
      select: quizResponseSelect,
    });
  }

  async listQuizzes(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<QuizResponse[]> {
    await this.findManageableCourseOrThrow(user, courseId);

    return this.prisma.quiz.findMany({
      where: { courseId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: quizResponseSelect,
    });
  }

  async getQuiz(user: AuthenticatedUser, quizId: string): Promise<QuizResponse> {
    return this.toQuizResponse(await this.findManageableQuizOrThrow(user, quizId));
  }

  async updateQuiz(
    user: AuthenticatedUser,
    quizId: string,
    input: UpdateQuizDto,
  ): Promise<QuizResponse> {
    const quiz = await this.findManageableQuizOrThrow(user, quizId);
    await this.assertLessonBelongsToCourse(input.lessonId, quiz.courseId);

    return this.prisma.quiz.update({
      where: { id: quizId },
      data: this.removeUndefinedFields({
        lessonId: input.lessonId,
        title: input.title,
        description: input.description,
        passingScore: input.passingScore,
        timeLimitMinutes: input.timeLimitMinutes,
      }),
      select: quizResponseSelect,
    });
  }

  async publishQuiz(
    user: AuthenticatedUser,
    quizId: string,
  ): Promise<QuizResponse> {
    await this.findManageableQuizOrThrow(user, quizId);

    return this.prisma.quiz.update({
      where: { id: quizId },
      data: { status: QuizStatus.published },
      select: quizResponseSelect,
    });
  }

  async deleteQuiz(
    user: AuthenticatedUser,
    quizId: string,
  ): Promise<DeletedQuizResponse> {
    await this.findManageableQuizOrThrow(user, quizId);
    await this.prisma.quiz.update({
      where: { id: quizId },
      data: { deletedAt: new Date(), status: QuizStatus.archived },
    });
    return { deleted: true };
  }

  async createQuestion(
    user: AuthenticatedUser,
    quizId: string,
    input: CreateQuestionDto,
  ): Promise<QuestionResponse> {
    await this.findManageableQuizOrThrow(user, quizId);

    try {
      return await this.prisma.question.create({
        data: {
          quizId,
          type: input.type,
          questionText: input.questionText,
          optionsJson: input.optionsJson,
          correctAnswerJson: input.correctAnswerJson,
          explanation: input.explanation,
          points: input.points,
          orderIndex: input.orderIndex,
        },
        select: questionResponseSelect,
      });
    } catch (error) {
      this.handleQuestionOrderConflict(error);
    }
  }

  async listQuestions(
    user: AuthenticatedUser,
    quizId: string,
  ): Promise<QuestionResponse[]> {
    await this.findManageableQuizOrThrow(user, quizId);
    return this.prisma.question.findMany({
      where: { quizId },
      orderBy: { orderIndex: 'asc' },
      select: questionResponseSelect,
    });
  }

  async updateQuestion(
    user: AuthenticatedUser,
    questionId: string,
    input: UpdateQuestionDto,
  ): Promise<QuestionResponse> {
    await this.findManageableQuestionOrThrow(user, questionId);

    try {
      return await this.prisma.question.update({
        where: { id: questionId },
        data: this.removeUndefinedFields({
          type: input.type,
          questionText: input.questionText,
          optionsJson: input.optionsJson,
          correctAnswerJson: input.correctAnswerJson,
          explanation: input.explanation,
          points: input.points,
          orderIndex: input.orderIndex,
        }),
        select: questionResponseSelect,
      });
    } catch (error) {
      this.handleQuestionOrderConflict(error);
    }
  }

  async deleteQuestion(
    user: AuthenticatedUser,
    questionId: string,
  ): Promise<DeletedQuestionResponse> {
    await this.findManageableQuestionOrThrow(user, questionId);
    await this.prisma.question.delete({ where: { id: questionId } });
    return { deleted: true };
  }

  private async findManageableCourseOrThrow(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<{ id: string; instructorId: string }> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true, instructorId: true },
    });

    if (!course || !this.canManage(user, course.instructorId)) {
      throw new NotFoundException('Course not found');
    }
    return course;
  }

  private async findManageableQuizOrThrow(
    user: AuthenticatedUser,
    quizId: string,
  ): Promise<ManageableQuiz> {
    const quiz = await this.prisma.quiz.findFirst({
      where: { id: quizId, deletedAt: null },
      select: {
        ...quizResponseSelect,
        course: { select: { instructorId: true } },
      },
    });

    if (!quiz || !this.canManage(user, quiz.course.instructorId)) {
      throw new NotFoundException('Quiz not found');
    }
    return quiz;
  }

  private async findManageableQuestionOrThrow(
    user: AuthenticatedUser,
    questionId: string,
  ): Promise<ManageableQuestion> {
    const question = await this.prisma.question.findFirst({
      where: { id: questionId, quiz: { deletedAt: null } },
      select: {
        ...questionResponseSelect,
        quiz: { select: { course: { select: { instructorId: true } } } },
      },
    });

    if (!question || !this.canManage(user, question.quiz.course.instructorId)) {
      throw new NotFoundException('Question not found');
    }
    return question;
  }

  private async assertLessonBelongsToCourse(
    lessonId: string | undefined,
    courseId: string,
  ): Promise<void> {
    if (!lessonId) return;
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, courseId, deletedAt: null },
      select: { id: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found in course');
  }

  private canManage(user: AuthenticatedUser, instructorId: string): boolean {
    return (
      user.roles.includes(RoleName.platform_admin) ||
      (user.roles.includes(RoleName.instructor) && user.id === instructorId)
    );
  }

  private toQuizResponse(quiz: ManageableQuiz): QuizResponse {
    const { course: _course, ...response } = quiz;
    return response;
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private handleQuestionOrderConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('Question order index is already in use');
    }
    throw error;
  }
}
