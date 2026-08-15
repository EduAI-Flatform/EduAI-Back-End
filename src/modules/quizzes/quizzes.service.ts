import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatus,
  Prisma,
  QuestionType,
  QuizStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { LearningPathService } from '../courses/learning-path.service';
import { CourseCompletionService } from '../courses/course-completion.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateQuizDto } from './dto/create-quiz.dto';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';
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
  maxAttempts: true,
  randomizeQuestions: true,
  randomizeOptions: true,
  showCorrectAnswers: true,
  isRequired: true,
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

const studentQuestionResponseSelect = {
  id: true,
  quizId: true,
  type: true,
  questionText: true,
  optionsJson: true,
  points: true,
  orderIndex: true,
} satisfies Prisma.QuestionSelect;

const attemptResponseSelect = {
  id: true,
  quizId: true,
  score: true,
  maxScore: true,
  passed: true,
  startedAt: true,
  submittedAt: true,
  createdAt: true,
} satisfies Prisma.QuizAttemptSelect;

export type QuizResponse = Prisma.QuizGetPayload<{
  select: typeof quizResponseSelect;
}>;

export type QuestionResponse = Prisma.QuestionGetPayload<{
  select: typeof questionResponseSelect;
}>;

export type StudentQuestionResponse = Prisma.QuestionGetPayload<{
  select: typeof studentQuestionResponseSelect;
}>;

export type StudentQuizResponse = QuizResponse & {
  questions: StudentQuestionResponse[];
};

type StoredAttemptResponse = Prisma.QuizAttemptGetPayload<{
  select: typeof attemptResponseSelect;
}>;

export type QuizAttemptResponse = StoredAttemptResponse & {
  scorePercent: number;
  answers?: QuizAttemptAnswerResponse[];
};

export interface QuizAttemptAnswerResponse {
  questionId: string;
  answer: unknown;
  isCorrect: boolean;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly courseCompletionService: CourseCompletionService,
    @Optional() private readonly learningPathService?: LearningPathService,
  ) {}

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
        maxAttempts: input.maxAttempts ?? null,
        randomizeQuestions: input.randomizeQuestions ?? false,
        randomizeOptions: input.randomizeOptions ?? false,
        showCorrectAnswers: input.showCorrectAnswers ?? true,
        isRequired: input.isRequired ?? true,
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
        maxAttempts: input.maxAttempts,
        randomizeQuestions: input.randomizeQuestions,
        randomizeOptions: input.randomizeOptions,
        showCorrectAnswers: input.showCorrectAnswers,
        isRequired: input.isRequired,
      }),
      select: quizResponseSelect,
    });
  }

  async publishQuiz(
    user: AuthenticatedUser,
    quizId: string,
  ): Promise<QuizResponse> {
    await this.findManageableQuizOrThrow(user, quizId);

    return this.prisma.$transaction(async (tx) => {
      const publishedQuiz = await tx.quiz.update({
        where: { id: quizId },
        data: { status: QuizStatus.published },
        select: quizResponseSelect,
      });
      await this.auditService.record(
        {
          actorId: user.id,
          action: AuditAction.QuizPublished,
          target: { type: 'quiz', id: quizId },
          metadata: { status: QuizStatus.published },
        },
        tx,
      );
      return publishedQuiz;
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

  async submitAttempt(
    userId: string,
    quizId: string,
    input: SubmitQuizAttemptDto,
  ): Promise<QuizAttemptResponse> {
    const quiz = await this.prisma.quiz.findFirst({
      where: {
        id: quizId,
        deletedAt: null,
        status: QuizStatus.published,
        course: {
          deletedAt: null,
          status: CourseStatus.published,
          enrollments: { some: { userId } },
        },
      },
      select: {
        id: true,
        courseId: true,
        passingScore: true,
        maxAttempts: true,
        showCorrectAnswers: true,
        questions: {
          orderBy: { orderIndex: 'asc' },
          select: {
            id: true,
            type: true,
            correctAnswerJson: true,
            points: true,
          },
        },
      },
    });

    if (!quiz) {
      throw new NotFoundException('Quiz not found');
    }

    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      quizId,
      'QUIZ',
    );

    this.validateAnswerSet(quiz.questions, input.answers);
    const answersByQuestionId = new Map(
      input.answers.map((answer) => [answer.questionId, answer.answer]),
    );
    const maxScore = quiz.questions.reduce(
      (total, question) => total + question.points,
      0,
    );
    const score = quiz.questions.reduce((total, question) => {
      const answer = answersByQuestionId.get(question.id);
      return this.answersMatch(answer, question.correctAnswerJson)
        ? total + question.points
        : total;
    }, 0);
    const scorePercent = maxScore === 0 ? 0 : (score / maxScore) * 100;
    const passed = scorePercent >= quiz.passingScore;
    const answerResults: QuizAttemptAnswerResponse[] = quiz.questions.map((question) => {
      const answer = answersByQuestionId.get(question.id);
      return {
        questionId: question.id,
        answer,
        isCorrect: this.answersMatch(answer, question.correctAnswerJson),
      };
    });
    const now = new Date();
    const storedAnswers = input.answers.map(({ questionId, answer }) => ({
      questionId,
      answer,
    })) as Prisma.InputJsonArray;
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      if (quiz.maxAttempts !== null && quiz.maxAttempts !== undefined) {
        // Serializes limit checks for this quiz before counting and inserting.
        // The parameterized row lock also prevents concurrent final submissions
        // from both passing the same count check.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "quizzes" WHERE "id" = ${quizId} FOR UPDATE`,
        );
        const attemptCount = await tx.quizAttempt.count({
          where: { quizId, userId, submittedAt: { not: null } },
        });
        if (attemptCount >= quiz.maxAttempts) {
          throw new BadRequestException('Quiz attempt limit reached');
        }
      }
      const created = await tx.quizAttempt.create({
        data: {
          quizId,
          userId,
          score,
          maxScore,
          passed,
          answersJson: storedAnswers,
          startedAt: now,
          submittedAt: now,
        },
        select: attemptResponseSelect,
      });
      const completion = await this.courseCompletionService.evaluateAndSync(
        tx,
        userId,
        quiz.courseId,
      );
      return { attempt: created, certificateIssued: completion.certificateIssued };
    });
    if (transactionResult.certificateIssued) {
      await this.courseCompletionService.publishCertificateIssued(
        transactionResult.certificateIssued,
      );
    }

    return {
      ...transactionResult.attempt,
      scorePercent: this.roundScore(scorePercent),
      ...(quiz.showCorrectAnswers ? { answers: answerResults } : {}),
    };
  }

  async getStudentQuiz(
    userId: string,
    quizId: string,
  ): Promise<StudentQuizResponse> {
    const quiz = await this.prisma.quiz.findFirst({
      where: this.studentPublishedQuizWhere(userId, quizId),
      select: {
        ...quizResponseSelect,
        questions: {
          orderBy: { orderIndex: 'asc' },
          select: studentQuestionResponseSelect,
        },
      },
    });

    if (!quiz) {
      throw new NotFoundException('Quiz not found');
    }

    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      quizId,
      'QUIZ',
    );

    const { questions, ...quizResponse } = quiz;
    const submittedAttemptCount = await this.prisma.quizAttempt.count({
      where: { quizId, userId, submittedAt: { not: null } },
    });
    const shuffledQuestions = quiz.randomizeQuestions
      ? this.shuffleDeterministically(questions, `${quizId}:${userId}:${submittedAttemptCount}:questions`)
      : questions;

    return {
      ...quizResponse,
      questions: shuffledQuestions.map((question, index) => ({
        id: question.id,
        quizId: question.quizId,
        type: question.type,
        questionText: question.questionText,
        optionsJson:
          quiz.randomizeOptions && Array.isArray(question.optionsJson)
            ? this.shuffleDeterministically(
                question.optionsJson,
                `${quizId}:${userId}:${submittedAttemptCount}:${question.id}:options`,
              )
            : question.optionsJson,
        points: question.points,
        orderIndex: quiz.randomizeQuestions ? index + 1 : question.orderIndex,
      })),
    };
  }

  async listStudentQuizzes(
    userId: string,
    courseId: string,
  ): Promise<QuizResponse[]> {
    return this.prisma.quiz.findMany({
      where: {
        courseId,
        deletedAt: null,
        status: QuizStatus.published,
        course: {
          deletedAt: null,
          status: CourseStatus.published,
          enrollments: { some: { userId } },
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: quizResponseSelect,
    });
  }

  async listMyAttempts(
    userId: string,
    quizId: string,
  ): Promise<QuizAttemptResponse[]> {
    await this.learningPathService?.assertStudentStepAccessible(
      userId,
      quizId,
      'QUIZ',
    );
    const attempts = await this.prisma.quizAttempt.findMany({
      where: { quizId, userId },
      orderBy: { createdAt: 'desc' },
      select: attemptResponseSelect,
    });

    return attempts.map((attempt) => ({
      ...attempt,
      scorePercent:
        attempt.score === null || !attempt.maxScore
          ? 0
          : this.roundScore((attempt.score / attempt.maxScore) * 100),
    }));
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

  private studentPublishedQuizWhere(
    userId: string,
    quizId: string,
  ): Prisma.QuizWhereInput {
    return {
      id: quizId,
      deletedAt: null,
      status: QuizStatus.published,
      course: {
        deletedAt: null,
        status: CourseStatus.published,
        enrollments: { some: { userId } },
      },
    };
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

  private validateAnswerSet(
    questions: Array<{ id: string; type: QuestionType }>,
    answers: SubmitQuizAttemptDto['answers'],
  ): void {
    const answerIds = answers.map((answer) => answer.questionId);
    const uniqueAnswerIds = new Set(answerIds);
    const questionIds = new Set(questions.map((question) => question.id));

    if (
      answers.length !== questions.length ||
      uniqueAnswerIds.size !== answers.length ||
      answerIds.some((questionId) => !questionIds.has(questionId))
    ) {
      throw new BadRequestException('Each quiz question must be answered once');
    }

    for (const question of questions) {
      const answer = answers.find((item) => item.questionId === question.id)?.answer;
      if (!this.isCompatibleAnswer(question.type, answer)) {
        throw new BadRequestException('Answer type does not match question type');
      }
    }
  }

  private isCompatibleAnswer(
    type: QuestionType,
    answer: Prisma.InputJsonValue | undefined,
  ): boolean {
    if (type === QuestionType.true_false) return typeof answer === 'boolean';
    if (type === QuestionType.short_answer) return typeof answer === 'string';
    return (
      typeof answer === 'string' ||
      typeof answer === 'number' ||
      Array.isArray(answer)
    );
  }

  private answersMatch(
    submitted: Prisma.InputJsonValue | undefined,
    correct: Prisma.JsonValue,
  ): boolean {
    return this.canonicalJson(submitted) === this.canonicalJson(correct);
  }

  private canonicalJson(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value.trim().toLowerCase());
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      return `{${Object.keys(objectValue)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(objectValue[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  }

  private roundScore(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private shuffleDeterministically<T>(items: readonly T[], seed: string): T[] {
    const shuffled = [...items];
    let state = 2166136261;
    for (const character of seed) {
      state ^= character.charCodeAt(0);
      state = Math.imul(state, 16777619);
    }
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const swapIndex = (state >>> 0) % (index + 1);
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex],
        shuffled[index],
      ];
    }
    return shuffled;
  }
}
