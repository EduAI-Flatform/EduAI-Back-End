import { BadGatewayException, ForbiddenException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  AssignmentStatus,
  CourseStatus,
  CourseVisibility,
  ModerationStatus,
  Prisma,
  QuizStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AI_PROVIDER, AiProvider } from './ai-provider';
import { AiRateLimitService } from './ai-rate-limit.service';

export interface LearningPathMilestone { courseId: string; reason: string; priority: number; }
export interface LearningPathOutput { schemaVersion: 'v1'; milestones: LearningPathMilestone[]; }
export interface LearningPathCourseSummary {
  id: string;
  title: string;
  slug: string;
  thumbnailUrl: string | null;
  level: string;
  progressPercent: number;
  enrollmentStatus: string | null;
}
export interface CurrentLearningPathMilestone extends LearningPathMilestone {
  available: boolean;
  course: LearningPathCourseSummary | null;
}
export interface CurrentLearningPathResponse {
  id: string;
  version: number;
  createdAt: Date;
  path: { schemaVersion: 'v1'; milestones: CurrentLearningPathMilestone[] };
}

@Injectable()
export class AiLearningPathService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: AiRateLimitService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AiProvider,
  ) {}

  async getCurrent(user: AuthenticatedUser): Promise<CurrentLearningPathResponse | null> {
    if (!user.roles.includes(RoleName.student)) throw new ForbiddenException('Student role required');
    const latest = await this.prisma.aiLearningPath.findFirst({
      where: { userId: user.id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, outputJson: true, createdAt: true },
    });
    if (!latest) return null;

    const path = this.parseStoredPath(latest.outputJson);
    const courseIds = [...new Set(path.milestones.map((milestone) => milestone.courseId))];
    const courses = await this.prisma.course.findMany({
      where: {
        id: { in: courseIds },
        status: CourseStatus.published,
        moderationStatus: ModerationStatus.clear,
        deletedAt: null,
        OR: [
          { visibility: CourseVisibility.public },
          { enrollments: { some: { userId: user.id, status: { in: ['active', 'completed'] } } } },
        ],
      },
      select: {
        id: true,
        title: true,
        slug: true,
        thumbnailUrl: true,
        level: true,
        enrollments: { where: { userId: user.id }, select: { status: true }, take: 1 },
        progress: { where: { userId: user.id }, select: { progressPercent: true }, take: 1 },
      },
    });
    const coursesById = new Map(courses.map((course) => [course.id, course]));

    return {
      id: latest.id,
      version: latest.version,
      createdAt: latest.createdAt,
      path: {
        schemaVersion: 'v1',
        milestones: [...path.milestones]
          .sort((left, right) => left.priority - right.priority)
          .map((milestone) => {
            const course = coursesById.get(milestone.courseId);
            return {
              ...milestone,
              available: Boolean(course),
              course: course
                ? {
                    id: course.id,
                    title: course.title,
                    slug: course.slug,
                    thumbnailUrl: course.thumbnailUrl,
                    level: course.level,
                    progressPercent: course.progress[0]?.progressPercent ?? 0,
                    enrollmentStatus: course.enrollments[0]?.status ?? null,
                  }
                : null,
            };
          }),
      },
    };
  }

  async regenerate(user: AuthenticatedUser): Promise<{ id: string; version: number; path: LearningPathOutput }> {
    if (!user.roles.includes(RoleName.student)) throw new ForbiddenException('Student role required');
    await this.rateLimit.assertLearningPathAllowed(user.id);
    const [profile, courses, latest] = await Promise.all([
      this.prisma.learningProfile.findUnique({ where: { userId: user.id }, select: { learningGoal: true, currentLevel: true, weeklyAvailabilityHours: true, skillGaps: { select: { name: true, currentLevel: true, targetLevel: true } } } }),
      this.prisma.course.findMany({
        where: { status: CourseStatus.published, moderationStatus: ModerationStatus.clear, deletedAt: null, OR: [{ visibility: CourseVisibility.public }, { enrollments: { some: { userId: user.id, status: { in: ['active', 'completed'] } } } }] },
        select: {
          id: true,
          title: true,
          description: true,
          level: true,
          enrollments: { where: { userId: user.id }, select: { status: true } },
          progress: { where: { userId: user.id }, select: { progressPercent: true } },
          quizzes: {
            where: { status: QuizStatus.published, deletedAt: null },
            select: {
              _count: { select: { attempts: { where: { userId: user.id } } } },
              attempts: {
                where: { userId: user.id, passed: true },
                select: { id: true },
                take: 1,
              },
            },
          },
          assignments: {
            where: { status: AssignmentStatus.published, deletedAt: null },
            select: {
              _count: { select: { submissions: { where: { userId: user.id } } } },
              submissions: {
                where: { userId: user.id, status: 'graded' },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
        take: 30,
      }),
      this.prisma.aiLearningPath.findFirst({ where: { userId: user.id }, orderBy: { version: 'desc' }, select: { version: true } }),
    ]);
    const input = {
      profile,
      courses: courses.map((course) => ({
        id: course.id,
        title: course.title,
        description: course.description,
        level: course.level,
        enrolled: course.enrollments.length > 0,
        progressPercent: course.progress[0]?.progressPercent ?? 0,
        quizSummary: {
          published: course.quizzes.length,
          attempted: course.quizzes.filter((quiz) => quiz._count.attempts > 0).length,
          passed: course.quizzes.filter((quiz) => quiz.attempts.length > 0).length,
        },
        assignmentSummary: {
          published: course.assignments.length,
          submitted: course.assignments.filter((assignment) => assignment._count.submissions > 0).length,
          graded: course.assignments.filter((assignment) => assignment.submissions.length > 0).length,
        },
      })),
    };
    const completion = await this.aiProvider.complete({ json: true, responseSchema: this.schema(), messages: [{ role: 'system', content: 'Return only valid JSON. Recommend only supplied course IDs and do not invent course content.' }, { role: 'user', content: `Create a short learner path from this safe JSON:\n${JSON.stringify(input)}` }] });
    const path = this.validate(completion.content, new Set(courses.map((course) => course.id)));
    const created = await this.prisma.aiLearningPath.create({ data: { userId: user.id, version: (latest?.version ?? 0) + 1, inputJson: input as Prisma.InputJsonValue, outputJson: path as unknown as Prisma.InputJsonValue, provider: this.aiProvider.getModel() === 'mock' ? 'mock' : 'configured', model: this.aiProvider.getModel() }, select: { id: true, version: true } });
    return { ...created, path };
  }

  private validate(raw: string | null, courseIds: Set<string>): LearningPathOutput {
    try {
      const parsed = JSON.parse((raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')) as LearningPathOutput;
      if (parsed?.schemaVersion !== 'v1' || !Array.isArray(parsed.milestones) || parsed.milestones.length > 6 || parsed.milestones.some((item) => !item || !courseIds.has(item.courseId) || !Number.isInteger(item.priority) || item.priority < 1 || typeof item.reason !== 'string' || !item.reason.trim())) throw new Error();
      return { schemaVersion: 'v1', milestones: parsed.milestones.map((item) => ({ courseId: item.courseId, priority: item.priority, reason: item.reason.trim() })) };
    } catch { throw new BadGatewayException('AI provider returned invalid learning path content'); }
  }

  private parseStoredPath(value: Prisma.JsonValue): LearningPathOutput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InternalServerErrorException('Stored learning path is invalid');
    }
    const candidate = value as unknown as LearningPathOutput;
    if (
      candidate.schemaVersion !== 'v1' ||
      !Array.isArray(candidate.milestones) ||
      candidate.milestones.length > 6 ||
      candidate.milestones.some((milestone) =>
        !milestone ||
        typeof milestone.courseId !== 'string' ||
        !milestone.courseId ||
        !Number.isInteger(milestone.priority) ||
        milestone.priority < 1 ||
        typeof milestone.reason !== 'string' ||
        !milestone.reason.trim()
      )
    ) {
      throw new InternalServerErrorException('Stored learning path is invalid');
    }
    return {
      schemaVersion: 'v1',
      milestones: candidate.milestones.map((milestone) => ({
        courseId: milestone.courseId,
        priority: milestone.priority,
        reason: milestone.reason.trim(),
      })),
    };
  }

  private schema(): Record<string, unknown> { return { type: 'object', properties: { schemaVersion: { type: 'string', enum: ['v1'] }, milestones: { type: 'array', maxItems: 6, items: { type: 'object', properties: { courseId: { type: 'string' }, reason: { type: 'string' }, priority: { type: 'integer', minimum: 1 } }, required: ['courseId', 'reason', 'priority'] } } }, required: ['schemaVersion', 'milestones'] }; }
}
