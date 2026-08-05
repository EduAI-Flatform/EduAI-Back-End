import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CourseStatus,
  Prisma,
  QuizStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateLessonProgressDto } from './dto/update-lesson-progress.dto';
import {
  buildLearningPathSteps,
  calculateLearningPathProgress,
  type LearningStep,
  type LearningStepCandidate,
} from './learning-path.rules';

const ACTIVE_ENROLLMENT_STATUSES = ['active', 'completed'];
const VIDEO_COMPLETION_THRESHOLD = 90;
const PROGRESS_NOT_STARTED_STATUS = 'not_started';
const PROGRESS_IN_PROGRESS_STATUS = 'in_progress';
const PROGRESS_COMPLETED_STATUS = 'completed';

const learningPathSelect = (userId: string) => ({
  id: true,
  lessons: {
    where: { deletedAt: null },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      title: true,
      type: true,
      orderIndex: true,
      isPreview: true,
      progress: {
        where: { userId },
        select: {
          status: true,
          progressPercent: true,
          watchedSeconds: true,
          durationSeconds: true,
          lastPositionSeconds: true,
          documentProgressPercent: true,
        },
        take: 1,
      },
    },
  },
  assignments: {
    where: { deletedAt: null, status: AssignmentStatus.published },
    select: {
      id: true,
      title: true,
      lessonId: true,
      submissions: {
        where: { userId },
        select: { id: true },
        take: 1,
      },
    },
  },
  quizzes: {
    where: { deletedAt: null, status: QuizStatus.published },
    select: {
      id: true,
      title: true,
      lessonId: true,
      attempts: {
        where: { userId, submittedAt: { not: null } },
        select: { id: true, passed: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  },
} satisfies Prisma.CourseSelect);

type LearningPathClient = Pick<
  PrismaService,
  'course' | 'lesson' | 'enrollment' | 'learningProgress'
>;

export interface LearningPathResponse {
  courseId: string;
  steps: LearningStep[];
  currentStep: LearningStep | null;
  nextStep: LearningStep | null;
  completedLessonIds: string[];
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  completed: boolean;
}

export interface LessonProgressResponse {
  lessonId: string;
  status: string;
  progressPercent: number;
  watchedSeconds: number;
  durationSeconds: number | null;
  lastPositionSeconds: number;
  documentProgressPercent: number;
  completedAt: Date | null;
}

@Injectable()
export class LearningPathService {
  constructor(private readonly prisma: PrismaService) {}

  async getLearningPath(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<LearningPathResponse> {
    if (!user.roles.includes(RoleName.student)) {
      throw new ForbiddenException('Student role required');
    }

    return this.getLearningPathForUser(this.prisma, user.id, courseId);
  }

  async updateLessonProgress(
    user: AuthenticatedUser,
    lessonId: string,
    input: UpdateLessonProgressDto,
  ): Promise<LearningPathResponse> {
    if (!user.roles.includes(RoleName.student)) {
      throw new ForbiddenException('Student role required');
    }

    return this.prisma.$transaction(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId, deletedAt: null, course: { deletedAt: null } },
        select: {
          id: true,
          courseId: true,
          type: true,
          durationMinutes: true,
        },
      });
      if (!lesson) throw new NotFoundException('Lesson not found');

      await this.assertEnrolled(tx, user.id, lesson.courseId);
      const current = await tx.learningProgress.findUnique({
        where: { userId_lessonId: { userId: user.id, lessonId } },
        select: {
          progressPercent: true,
          watchedSeconds: true,
          durationSeconds: true,
          lastPositionSeconds: true,
          maxWatchedSeconds: true,
          documentProgressPercent: true,
        },
      });

      const next = this.calculateProgressValues(lesson, current, input);
      await tx.learningProgress.upsert({
        where: { userId_lessonId: { userId: user.id, lessonId } },
        create: {
          userId: user.id,
          courseId: lesson.courseId,
          lessonId,
          status: next.status,
          progressPercent: next.progressPercent,
          watchedSeconds: next.watchedSeconds,
          durationSeconds: next.durationSeconds,
          lastPositionSeconds: next.lastPositionSeconds,
          maxWatchedSeconds: next.maxWatchedSeconds,
          documentProgressPercent: next.documentProgressPercent,
          completedAt: next.completed ? new Date() : null,
          lastAccessedAt: new Date(),
        },
        update: {
          status: next.status,
          progressPercent: next.progressPercent,
          watchedSeconds: next.watchedSeconds,
          durationSeconds: next.durationSeconds,
          lastPositionSeconds: next.lastPositionSeconds,
          maxWatchedSeconds: next.maxWatchedSeconds,
          documentProgressPercent: next.documentProgressPercent,
          completedAt: next.completed ? new Date() : null,
          lastAccessedAt: new Date(),
        },
      });

      const path = await this.getLearningPathForUser(tx, user.id, lesson.courseId);
      if (path.completed) {
        await tx.enrollment.updateMany({
          where: {
            userId: user.id,
            courseId: lesson.courseId,
            status: { not: 'completed' },
          },
          data: { status: 'completed', completedAt: new Date() },
        });
      }
      return path;
    });
  }

  async getLessonProgress(
    user: AuthenticatedUser,
    lessonId: string,
  ): Promise<LessonProgressResponse> {
    if (!user.roles.includes(RoleName.student)) {
      throw new ForbiddenException('Student role required');
    }

    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null, course: { deletedAt: null } },
      select: { id: true, courseId: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    await this.assertEnrolled(this.prisma, user.id, lesson.courseId);
    await this.assertLessonAccessible(user, lessonId);
    const progress = await this.prisma.learningProgress.findUnique({
      where: { userId_lessonId: { userId: user.id, lessonId } },
      select: {
        status: true,
        progressPercent: true,
        watchedSeconds: true,
        durationSeconds: true,
        lastPositionSeconds: true,
        documentProgressPercent: true,
        completedAt: true,
      },
    });

    return {
      lessonId,
      status: progress?.status ?? PROGRESS_NOT_STARTED_STATUS,
      progressPercent: progress?.progressPercent ?? 0,
      watchedSeconds: progress?.watchedSeconds ?? 0,
      durationSeconds: progress?.durationSeconds ?? null,
      lastPositionSeconds: progress?.lastPositionSeconds ?? 0,
      documentProgressPercent: progress?.documentProgressPercent ?? 0,
      completedAt: progress?.completedAt ?? null,
    };
  }

  async assertLessonAccessible(
    user: AuthenticatedUser,
    lessonId: string,
  ): Promise<void> {
    if (!user.roles.includes(RoleName.student)) return;

    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: { courseId: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    const path = await this.getLearningPathForUser(this.prisma, user.id, lesson.courseId);
    const step = path.steps.find(
      (candidate) => candidate.type === 'LESSON' && candidate.id === lessonId,
    );
    if (!step || step.status === 'LOCKED') {
      throw new NotFoundException('Lesson not found');
    }
  }

  async assertStudentStepAccessible(
    userId: string,
    stepId: string,
    type: 'ASSIGNMENT' | 'QUIZ',
  ): Promise<void> {
    const courseId = await this.findStepCourseId(type, stepId);
    const path = await this.getLearningPathForUser(this.prisma, userId, courseId);
    const step = path.steps.find(
      (candidate) => candidate.id === stepId && candidate.type === type,
    );
    if (!step || step.status === 'LOCKED') {
      throw new NotFoundException('Learning step not found');
    }
  }

  private async getLearningPathForUser(
    client: LearningPathClient,
    userId: string,
    courseId: string,
  ): Promise<LearningPathResponse> {
    const course = await client.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
        status: CourseStatus.published,
        enrollments: {
          some: { userId, status: { in: ACTIVE_ENROLLMENT_STATUSES } },
        },
      },
      select: learningPathSelect(userId),
    });
    if (!course) throw new NotFoundException('Course or enrollment not found');

    const lessonPositions = new Map(
      course.lessons.map((lesson) => [lesson.id, lesson.orderIndex]),
    );
    const maxPosition = course.lessons.reduce(
      (max, lesson) => Math.max(max, lesson.orderIndex),
      0,
    );
    const candidates: LearningStepCandidate[] = course.lessons.map((lesson) => {
      const progress = lesson.progress[0];
      return {
        id: lesson.id,
        type: 'LESSON',
        title: lesson.title,
        position: lesson.orderIndex,
        lessonId: lesson.id,
        isPreview: lesson.isPreview,
        progressPercent: progress?.progressPercent ?? 0,
        watchedSeconds: progress?.watchedSeconds ?? 0,
        durationSeconds: progress?.durationSeconds ?? null,
        lastPositionSeconds: progress?.lastPositionSeconds ?? 0,
        documentProgressPercent: progress?.documentProgressPercent ?? 0,
        completed: progress?.status === PROGRESS_COMPLETED_STATUS,
        inProgress:
          progress?.status === PROGRESS_IN_PROGRESS_STATUS ||
          (progress?.progressPercent ?? 0) > 0,
      };
    });

    candidates.push(
      ...course.assignments.map((assignment) => ({
        id: assignment.id,
        type: 'ASSIGNMENT' as const,
        title: assignment.title,
        position: assignment.lessonId
          ? (lessonPositions.get(assignment.lessonId) ?? maxPosition + 1)
          : maxPosition + 1,
        lessonId: assignment.lessonId,
        completed: assignment.submissions.length > 0,
        inProgress: assignment.submissions.length > 0,
      })),
      ...course.quizzes.map((quiz) => ({
        id: quiz.id,
        type: 'QUIZ' as const,
        title: quiz.title,
        position: quiz.lessonId
          ? (lessonPositions.get(quiz.lessonId) ?? maxPosition + 1)
          : maxPosition + 1,
        lessonId: quiz.lessonId,
        completed: quiz.attempts.some((attempt) => attempt.passed === true),
        inProgress: quiz.attempts.length > 0,
      })),
    );

    const steps = buildLearningPathSteps(candidates);
    const progress = calculateLearningPathProgress(steps);
    const currentStep =
      steps.find((step) => step.status === 'IN_PROGRESS') ??
      steps.find((step) => step.status === 'AVAILABLE') ??
      null;
    const currentIndex = currentStep ? steps.indexOf(currentStep) : -1;

    return {
      courseId,
      steps,
      currentStep,
      nextStep:
        currentIndex >= 0 && currentIndex < steps.length - 1
          ? steps[currentIndex + 1]
          : null,
      completedLessonIds: steps
        .filter((step) => step.type === 'LESSON' && step.status === 'COMPLETED')
        .map((step) => step.id),
      ...progress,
    };
  }

  private async assertEnrolled(
    client: LearningPathClient,
    userId: string,
    courseId: string,
  ): Promise<void> {
    const enrollment = await client.enrollment.findFirst({
      where: {
        userId,
        courseId,
        status: { in: ACTIVE_ENROLLMENT_STATUSES },
      },
      select: { id: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
  }

  private async findStepCourseId(
    type: 'ASSIGNMENT' | 'QUIZ',
    stepId: string,
  ): Promise<string> {
    const record =
      type === 'ASSIGNMENT'
        ? await this.prisma.assignment.findFirst({
            where: { id: stepId, deletedAt: null },
            select: { courseId: true },
          })
        : await this.prisma.quiz.findFirst({
            where: { id: stepId, deletedAt: null },
            select: { courseId: true },
          });

    if (!record) throw new NotFoundException('Learning step not found');
    return record.courseId;
  }

  private calculateProgressValues(
    lesson: {
      type: string;
      durationMinutes: number | null;
    },
    current: {
      progressPercent: number;
      watchedSeconds: number;
      durationSeconds: number | null;
      lastPositionSeconds: number;
      maxWatchedSeconds: number;
      documentProgressPercent: number;
    } | null,
    input: UpdateLessonProgressDto,
  ) {
    const previous = current ?? {
      progressPercent: 0,
      watchedSeconds: 0,
      durationSeconds: null,
      lastPositionSeconds: 0,
      maxWatchedSeconds: 0,
      documentProgressPercent: 0,
    };

    if (lesson.type === 'video') {
      const durationSeconds = Math.max(
        0,
        Math.round(
          input.durationSeconds ??
            previous.durationSeconds ??
            (lesson.durationMinutes ?? 0) * 60,
        ),
      );
      const requestedPositionSeconds = Math.min(
        durationSeconds || Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.round(input.lastPositionSeconds ?? previous.lastPositionSeconds)),
      );
      const canAdvance =
        requestedPositionSeconds <= previous.maxWatchedSeconds + 5;
      const safeLastPositionSeconds = canAdvance
        ? requestedPositionSeconds
        : previous.lastPositionSeconds;
      const safeWatchedSeconds = canAdvance
        ? Math.min(
            durationSeconds || Number.MAX_SAFE_INTEGER,
            Math.max(
              previous.watchedSeconds,
              Math.round(input.watchedSeconds ?? requestedPositionSeconds),
              requestedPositionSeconds,
            ),
          )
        : previous.watchedSeconds;
      const maxWatchedSeconds = Math.max(
        previous.maxWatchedSeconds,
        safeLastPositionSeconds,
      );
      const progressPercent = durationSeconds
        ? Math.min(100, Math.round((safeWatchedSeconds / durationSeconds) * 100))
        : previous.progressPercent;
      const completed =
        durationSeconds > 0 && progressPercent >= VIDEO_COMPLETION_THRESHOLD;

      return {
        status: completed
          ? PROGRESS_COMPLETED_STATUS
          : progressPercent > 0
            ? PROGRESS_IN_PROGRESS_STATUS
            : PROGRESS_NOT_STARTED_STATUS,
        progressPercent,
        watchedSeconds: safeWatchedSeconds,
        durationSeconds,
        lastPositionSeconds: safeLastPositionSeconds,
        maxWatchedSeconds,
        documentProgressPercent: previous.documentProgressPercent,
        completed,
      };
    }

    const documentProgressPercent = Math.min(
      100,
      Math.max(
        previous.documentProgressPercent,
        input.documentProgressPercent ?? previous.documentProgressPercent,
      ),
    );
    const completed = documentProgressPercent >= VIDEO_COMPLETION_THRESHOLD;
    return {
      status: completed
        ? PROGRESS_COMPLETED_STATUS
        : documentProgressPercent > 0
          ? PROGRESS_IN_PROGRESS_STATUS
          : PROGRESS_NOT_STARTED_STATUS,
      progressPercent: documentProgressPercent,
      watchedSeconds: previous.watchedSeconds,
      durationSeconds: previous.durationSeconds,
      lastPositionSeconds: previous.lastPositionSeconds,
      maxWatchedSeconds: previous.maxWatchedSeconds,
      documentProgressPercent,
      completed,
    };
  }
}
