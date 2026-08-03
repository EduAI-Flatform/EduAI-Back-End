import { Injectable } from '@nestjs/common';
import {
  ClassroomSessionStatus,
  CourseStatus,
  Prisma,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_ACTIVITY_LIMIT = 8;
const DASHBOARD_SESSION_LIMIT = 5;
const WORK_QUEUE_LIMIT = 6;

const dashboardSessionSelect = {
  id: true,
  title: true,
  scheduledStart: true,
  scheduledEnd: true,
  meetingUrl: true,
  status: true,
  course: {
    select: {
      id: true,
      title: true,
      slug: true,
    },
  },
  instructor: {
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.ClassroomSessionSelect;

const dashboardCertificateSelect = {
  id: true,
  certificateCode: true,
  title: true,
  issuedAt: true,
  verificationUrl: true,
  qrCodeUrl: true,
  course: {
    select: {
      id: true,
      title: true,
    },
  },
} satisfies Prisma.CertificateSelect;

export type DashboardSession = Prisma.ClassroomSessionGetPayload<{
  select: typeof dashboardSessionSelect;
}>;

interface DashboardCertificate {
  id: string;
  certificateCode: string;
  title: string;
  issuedAt: Date;
  verificationUrl: string | null;
  qrCodeUrl: string | null;
  courseTitle: string;
}

interface DashboardActiveCourse {
  enrollmentId: string;
  status: string;
  enrolledAt: Date;
  completedAt: Date | null;
  course: {
    id: string;
    title: string;
    slug: string;
    thumbnailUrl: string | null;
    badge: string | null;
  };
  progress: {
    completedLessons: number;
    totalLessons: number;
    progressPercent: number;
    completedMinutes: number;
    totalMinutes: number;
    remainingMinutes: number;
  };
  lastAccessedAt: Date | null;
  nextLesson: { id: string; title: string } | null;
}

interface WeeklyCompletedMinutes {
  date: string;
  minutes: number;
}

type DashboardActivityType =
  | 'lesson_completed'
  | 'quiz_attempt'
  | 'certificate_issued';

interface DashboardActivity {
  id: string;
  type: DashboardActivityType;
  title: string;
  occurredAt: Date;
  courseId: string;
  courseTitle: string;
  score: number | null;
}

export interface StudentDashboardResponse {
  activeCourses: DashboardActiveCourse[];
  continueCourse: DashboardActiveCourse | null;
  upcomingSessions: DashboardSession[];
  weeklyCompletedMinutes: WeeklyCompletedMinutes[];
  statistics: {
    completedMinutes: number;
    completedCourses: number;
    averageQuizScore: number | null;
    completedLessons: number;
  };
  certificates: DashboardCertificate[];
  recentActivity: DashboardActivity[];
}

type WorkQueueType = 'submission' | 'session' | 'draft_course';
type WorkQueuePriority = 'urgent' | 'normal';

interface InstructorWorkQueueItem {
  id: string;
  type: WorkQueueType;
  title: string;
  description: string;
  dueAt: Date;
  priority: WorkQueuePriority;
}

export interface InstructorDashboardResponse {
  statistics: {
    publishedCourses: number;
    activeStudents: number;
    pendingSubmissions: number;
    upcomingSessions: number;
    todaySessions: number;
    completionRate: number;
  };
  upcomingSessions: DashboardSession[];
  workQueue: InstructorWorkQueueItem[];
}

interface StudentEnrollmentRecord {
  id: string;
  status: string;
  enrolledAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
  course: {
    id: string;
    title: string;
    slug: string;
    thumbnailUrl: string | null;
    badge: string | null;
    lessons: Array<{
      id: string;
      title: string;
      orderIndex: number;
      durationMinutes: number | null;
    }>;
    progress: Array<{
      lessonId: string;
      status: string;
      progressPercent: number;
      completedAt: Date | null;
      lastAccessedAt: Date | null;
    }>;
  };
}

interface CompletedProgressRecord {
  id: string;
  courseId: string;
  lessonId: string;
  completedAt: Date | null;
  lesson: {
    title: string;
    durationMinutes: number | null;
  };
  course: {
    id: string;
    title: string;
    slug: string;
  };
}

interface QuizAttemptRecord {
  id: string;
  score: number | null;
  maxScore: number | null;
  submittedAt: Date | null;
  quiz: {
    title: string;
    courseId: string;
    course: {
      title: string;
    };
  };
}

@Injectable()
export class DashboardsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStudentDashboard(userId: string): Promise<StudentDashboardResponse> {
    const now = new Date();
    const [
      enrollmentRecords,
      completedProgress,
      completedCourses,
      quizAttempts,
      upcomingSessions,
      certificateRecords,
    ] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: {
          userId,
          status: 'active',
          course: {
            deletedAt: null,
            status: CourseStatus.published,
          },
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          enrolledAt: true,
          completedAt: true,
          updatedAt: true,
          course: {
            select: {
              id: true,
              title: true,
              slug: true,
              thumbnailUrl: true,
              badge: true,
              lessons: {
                where: { deletedAt: null },
                orderBy: { orderIndex: 'asc' },
                select: {
                  id: true,
                  title: true,
                  orderIndex: true,
                  durationMinutes: true,
                },
              },
              progress: {
                where: { userId },
                select: {
                  lessonId: true,
                  status: true,
                  progressPercent: true,
                  completedAt: true,
                  lastAccessedAt: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.learningProgress.findMany({
        where: {
          userId,
          status: 'completed',
          completedAt: { not: null },
          lesson: { deletedAt: null },
          course: { deletedAt: null },
        },
        select: {
          id: true,
          courseId: true,
          lessonId: true,
          completedAt: true,
          lesson: {
            select: {
              title: true,
              durationMinutes: true,
            },
          },
          course: {
            select: {
              id: true,
              title: true,
              slug: true,
            },
          },
        },
      }),
      this.prisma.enrollment.count({
        where: {
          userId,
          status: 'completed',
          completedAt: { not: null },
          course: { deletedAt: null },
        },
      }),
      this.prisma.quizAttempt.findMany({
        where: {
          userId,
          submittedAt: { not: null },
          score: { not: null },
          maxScore: { gt: 0 },
        },
        select: {
          id: true,
          score: true,
          maxScore: true,
          submittedAt: true,
          quiz: {
            select: {
              title: true,
              courseId: true,
              course: {
                select: {
                  title: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.classroomSession.findMany({
        where: {
          deletedAt: null,
          status: {
            in: [
              ClassroomSessionStatus.scheduled,
              ClassroomSessionStatus.live,
            ],
          },
          scheduledEnd: { gte: now },
          course: {
            deletedAt: null,
            enrollments: {
              some: {
                userId,
                status: { in: ['active', 'completed'] },
              },
            },
          },
        },
        orderBy: { scheduledStart: 'asc' },
        take: DASHBOARD_SESSION_LIMIT,
        select: dashboardSessionSelect,
      }),
      this.prisma.certificate.findMany({
        where: { userId },
        orderBy: { issuedAt: 'desc' },
        take: 4,
        select: dashboardCertificateSelect,
      }),
    ]);

    const activeCourses = (
      enrollmentRecords as StudentEnrollmentRecord[]
    )
      .map((enrollment) => this.toDashboardActiveCourse(enrollment))
      .sort(
        (left, right) =>
          (right.lastAccessedAt?.getTime() ?? 0) -
          (left.lastAccessedAt?.getTime() ?? 0),
      );
    const progressRecords = completedProgress as CompletedProgressRecord[];
    const attempts = quizAttempts as QuizAttemptRecord[];
    const certificates = certificateRecords.map(({ course, ...certificate }) => ({
      ...certificate,
      courseTitle: course.title,
    }));

    return {
      activeCourses,
      continueCourse: activeCourses[0] ?? null,
      upcomingSessions,
      weeklyCompletedMinutes: this.toWeeklyCompletedMinutes(
        progressRecords,
        now,
      ),
      statistics: {
        completedMinutes: progressRecords.reduce(
          (total, progress) =>
            total + Math.max(0, progress.lesson.durationMinutes ?? 0),
          0,
        ),
        completedCourses,
        averageQuizScore: this.averageQuizScore(attempts),
        completedLessons: progressRecords.length,
      },
      certificates,
      recentActivity: this.toRecentActivity(
        progressRecords,
        attempts,
        certificateRecords,
      ),
    };
  }

  async getInstructorDashboard(
    user: AuthenticatedUser,
  ): Promise<InstructorDashboardResponse> {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const todayStart = this.utcStartOfDay(now);
    const nextDayStart = new Date(todayStart.getTime() + DAY_MS);
    const isAdmin = user.roles.includes(RoleName.platform_admin);
    const managedCourseWhere: Prisma.CourseWhereInput = {
      deletedAt: null,
      ...(isAdmin ? {} : { instructorId: user.id }),
    };
    const sessionWhere: Prisma.ClassroomSessionWhereInput = {
      deletedAt: null,
      status: {
        in: [
          ClassroomSessionStatus.scheduled,
          ClassroomSessionStatus.live,
        ],
      },
      scheduledEnd: { gte: now },
      ...(isAdmin ? {} : { instructorId: user.id }),
      course: managedCourseWhere,
    };

    const [
      publishedCourses,
      activeStudentRecords,
      pendingSubmissions,
      enrollmentGroups,
      upcomingSessionCount,
      todaySessions,
      upcomingSessions,
      pendingSubmissionRecords,
      draftCourses,
    ] = await Promise.all([
      this.prisma.course.count({
        where: {
          ...managedCourseWhere,
          status: CourseStatus.published,
        },
      }),
      this.prisma.enrollment.findMany({
        where: {
          status: 'active',
          course: {
            ...managedCourseWhere,
            status: CourseStatus.published,
          },
        },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.submission.count({
        where: {
          status: SubmissionStatus.submitted,
          assignment: {
            deletedAt: null,
            course: managedCourseWhere,
          },
        },
      }),
      this.prisma.enrollment.groupBy({
        by: ['status'],
        where: {
          status: { in: ['active', 'completed'] },
          course: managedCourseWhere,
        },
        _count: { _all: true },
      }),
      this.prisma.classroomSession.count({
        where: sessionWhere,
      }),
      this.prisma.classroomSession.count({
        where: {
          deletedAt: null,
          status: { not: ClassroomSessionStatus.cancelled },
          scheduledStart: {
            gte: todayStart,
            lt: nextDayStart,
          },
          ...(isAdmin ? {} : { instructorId: user.id }),
          course: managedCourseWhere,
        },
      }),
      this.prisma.classroomSession.findMany({
        where: sessionWhere,
        orderBy: { scheduledStart: 'asc' },
        take: DASHBOARD_SESSION_LIMIT,
        select: dashboardSessionSelect,
      }),
      this.prisma.submission.findMany({
        where: {
          status: SubmissionStatus.submitted,
          assignment: {
            deletedAt: null,
            course: managedCourseWhere,
          },
        },
        orderBy: { submittedAt: 'asc' },
        take: 3,
        select: {
          id: true,
          submittedAt: true,
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
          assignment: {
            select: {
              id: true,
              title: true,
              dueDate: true,
              course: {
                select: {
                  id: true,
                  title: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.course.findMany({
        where: {
          ...managedCourseWhere,
          status: CourseStatus.draft,
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: {
          id: true,
          title: true,
          updatedAt: true,
          _count: {
            select: {
              lessons: {
                where: { deletedAt: null },
              },
            },
          },
        },
      }),
    ]);

    const totalEnrollments = enrollmentGroups.reduce(
      (total, group) => total + group._count._all,
      0,
    );
    const completedEnrollments =
      enrollmentGroups.find((group) => group.status === 'completed')?._count
        ._all ?? 0;

    return {
      statistics: {
        publishedCourses,
        activeStudents: activeStudentRecords.length,
        pendingSubmissions,
        upcomingSessions: upcomingSessionCount,
        todaySessions,
        completionRate:
          totalEnrollments === 0
            ? 0
            : Math.round((completedEnrollments / totalEnrollments) * 100),
      },
      upcomingSessions,
      workQueue: this.toInstructorWorkQueue(
        pendingSubmissionRecords,
        upcomingSessions,
        draftCourses,
        now,
        tomorrow,
      ),
    };
  }

  private toDashboardActiveCourse(
    enrollment: StudentEnrollmentRecord,
  ): DashboardActiveCourse {
    const completedLessonIds = new Set(
      enrollment.course.progress
        .filter(
          (progress) =>
            progress.status === 'completed' || progress.completedAt !== null,
        )
        .map((progress) => progress.lessonId),
    );
    const completedLessons = enrollment.course.lessons.filter((lesson) =>
      completedLessonIds.has(lesson.id),
    );
    const totalMinutes = enrollment.course.lessons.reduce(
      (total, lesson) => total + Math.max(0, lesson.durationMinutes ?? 0),
      0,
    );
    const completedMinutes = completedLessons.reduce(
      (total, lesson) => total + Math.max(0, lesson.durationMinutes ?? 0),
      0,
    );
    const lastAccessedAt = enrollment.course.progress.reduce<Date | null>(
      (latest, progress) => {
        if (!progress.lastAccessedAt) return latest;
        if (!latest || progress.lastAccessedAt > latest) {
          return progress.lastAccessedAt;
        }
        return latest;
      },
      null,
    );
    const totalLessons = enrollment.course.lessons.length;
    const nextLesson = enrollment.course.lessons.find(
      (lesson) => !completedLessonIds.has(lesson.id),
    );

    return {
      enrollmentId: enrollment.id,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
      course: {
        id: enrollment.course.id,
        title: enrollment.course.title,
        slug: enrollment.course.slug,
        thumbnailUrl: enrollment.course.thumbnailUrl,
        badge: enrollment.course.badge,
      },
      progress: {
        completedLessons: completedLessons.length,
        totalLessons,
        progressPercent:
          totalLessons === 0
            ? 0
            : Math.round((completedLessons.length / totalLessons) * 100),
        completedMinutes,
        totalMinutes,
        remainingMinutes: Math.max(0, totalMinutes - completedMinutes),
      },
      lastAccessedAt: lastAccessedAt ?? enrollment.updatedAt,
      nextLesson: nextLesson
        ? { id: nextLesson.id, title: nextLesson.title }
        : null,
    };
  }

  private toWeeklyCompletedMinutes(
    progressRecords: CompletedProgressRecord[],
    now: Date,
  ): WeeklyCompletedMinutes[] {
    const today = this.utcStartOfDay(now);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today.getTime() - (6 - index) * DAY_MS);
      return {
        date: this.toUtcDateKey(date),
        minutes: 0,
      };
    });
    const minutesByDate = new Map(days.map((day) => [day.date, day]));

    for (const progress of progressRecords) {
      if (!progress.completedAt) continue;
      const bucket = minutesByDate.get(this.toUtcDateKey(progress.completedAt));
      if (bucket) {
        bucket.minutes += Math.max(0, progress.lesson.durationMinutes ?? 0);
      }
    }

    return days;
  }

  private averageQuizScore(attempts: QuizAttemptRecord[]): number | null {
    const scores = attempts
      .map((attempt) => this.toQuizPercent(attempt.score, attempt.maxScore))
      .filter((score): score is number => score !== null);

    if (scores.length === 0) return null;

    const average = scores.reduce((total, score) => total + score, 0) /
      scores.length;
    return Math.round(average * 100) / 100;
  }

  private toRecentActivity(
    progressRecords: CompletedProgressRecord[],
    quizAttempts: QuizAttemptRecord[],
    certificates: Prisma.CertificateGetPayload<{
      select: typeof dashboardCertificateSelect;
    }>[],
  ): DashboardActivity[] {
    const lessonActivity: DashboardActivity[] = progressRecords
      .filter(
        (
          progress,
        ): progress is CompletedProgressRecord & { completedAt: Date } =>
          progress.completedAt !== null,
      )
      .map((progress) => ({
        id: `lesson:${progress.id}`,
        type: 'lesson_completed',
        title: progress.lesson.title,
        occurredAt: progress.completedAt,
        courseId: progress.courseId,
        courseTitle: progress.course.title,
        score: null,
      }));
    const quizActivity: DashboardActivity[] = quizAttempts
      .filter(
        (attempt): attempt is QuizAttemptRecord & { submittedAt: Date } =>
          attempt.submittedAt !== null,
      )
      .map((attempt) => ({
        id: `quiz:${attempt.id}`,
        type: 'quiz_attempt',
        title: attempt.quiz.title,
        occurredAt: attempt.submittedAt,
        courseId: attempt.quiz.courseId,
        courseTitle: attempt.quiz.course.title,
        score: this.toQuizPercent(attempt.score, attempt.maxScore),
      }));
    const certificateActivity: DashboardActivity[] = certificates.map(
      (certificate) => ({
        id: `certificate:${certificate.id}`,
        type: 'certificate_issued',
        title: certificate.title,
        occurredAt: certificate.issuedAt,
        courseId: certificate.course.id,
        courseTitle: certificate.course.title,
        score: null,
      }),
    );

    return [...lessonActivity, ...quizActivity, ...certificateActivity]
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime(),
      )
      .slice(0, DASHBOARD_ACTIVITY_LIMIT);
  }

  private toInstructorWorkQueue(
    submissions: Array<{
      id: string;
      submittedAt: Date;
      user: { id: string; fullName: string; avatarUrl: string | null };
      assignment: {
        id: string;
        title: string;
        dueDate: Date | null;
        course: { id: string; title: string };
      };
    }>,
    sessions: DashboardSession[],
    draftCourses: Array<{
      id: string;
      title: string;
      updatedAt: Date;
      _count: { lessons: number };
    }>,
    now: Date,
    urgentBefore: Date,
  ): InstructorWorkQueueItem[] {
    const submissionItems: InstructorWorkQueueItem[] = submissions.map(
      (submission) => {
        const dueAt =
          submission.assignment.dueDate ?? submission.submittedAt;
        return {
          id: submission.id,
          type: 'submission',
          title: `Chấm bài ${submission.assignment.title}`,
          description: `${submission.user.fullName} · ${submission.assignment.course.title}`,
          dueAt,
          priority: dueAt <= urgentBefore ? 'urgent' : 'normal',
        };
      },
    );
    const sessionItems: InstructorWorkQueueItem[] = sessions
      .slice(0, 3)
      .map((session) => ({
        id: session.id,
        type: 'session',
        title: session.title,
        description: session.course.title,
        dueAt: session.scheduledStart,
        priority:
          session.scheduledStart >= now && session.scheduledStart <= urgentBefore
            ? 'urgent'
            : 'normal',
      }));
    const draftItems: InstructorWorkQueueItem[] = draftCourses.map((course) => ({
      id: course.id,
      type: 'draft_course',
      title: `Hoàn thiện ${course.title}`,
      description: `${course._count.lessons} bài học đang soạn`,
      dueAt: course.updatedAt,
      priority: 'normal',
    }));

    return [...submissionItems, ...sessionItems, ...draftItems]
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority === 'urgent' ? -1 : 1;
        }
        return left.dueAt.getTime() - right.dueAt.getTime();
      })
      .slice(0, WORK_QUEUE_LIMIT);
  }

  private toQuizPercent(
    score: number | null,
    maxScore: number | null,
  ): number | null {
    if (score === null || maxScore === null || maxScore <= 0) return null;
    return Math.round((score / maxScore) * 10000) / 100;
  }

  private utcStartOfDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private toUtcDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
