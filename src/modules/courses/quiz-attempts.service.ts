import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatus,
  Prisma,
  QuestionType,
  QuizStatus,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';

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

type StoredAttemptResponse = Prisma.QuizAttemptGetPayload<{
  select: typeof attemptResponseSelect;
}>;

export type QuizAttemptResponse = StoredAttemptResponse & {
  scorePercent: number;
};

@Injectable()
export class QuizAttemptsService {
  constructor(private readonly prisma: PrismaService) {}

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
        passingScore: true,
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
    const now = new Date();
    const storedAnswers = input.answers.map(({ questionId, answer }) => ({
      questionId,
      answer,
    })) as Prisma.InputJsonArray;
    const attempt = await this.prisma.quizAttempt.create({
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

    return { ...attempt, scorePercent: this.roundScore(scorePercent) };
  }

  async listMyAttempts(
    userId: string,
    quizId: string,
  ): Promise<QuizAttemptResponse[]> {
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
}
