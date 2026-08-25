import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CourseAccessGrantStatus,
  CourseAccessSourceType,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAccessService } from '../access/course-access.service';
import { EmergencyMembershipCourseRevocationDto } from './dto/membership-plan.dto';

type DatabaseClient = Prisma.TransactionClient | PrismaService;

export interface MembershipContinuityVersion {
  id: string;
  includedCourses: Array<{
    courseId: string;
    graceDays: number;
    course: { id: string; title: string; slug: string };
  }>;
}

export interface RemovedCourseContinuity {
  courseId: string;
  title: string;
  slug: string;
  startedBeforeRemoval: boolean;
  graceDays: number;
  graceStartsAt: Date | null;
  graceEndsAt: Date | null;
}

@Injectable()
export class MembershipContinuityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseAccess: CourseAccessService,
    private readonly audit: AuditService,
  ) {}

  async resolveRemovedCourses(
    client: DatabaseClient,
    learnerId: string,
    currentVersion: MembershipContinuityVersion | null,
    targetVersion: MembershipContinuityVersion,
    currentTermEndsAt: Date | null,
    at: Date,
  ): Promise<RemovedCourseContinuity[]> {
    if (!currentVersion || currentVersion.id === targetVersion.id) return [];
    const targetCourseIds = new Set(targetVersion.includedCourses.map((item) => item.courseId));
    const removed = currentVersion.includedCourses.filter((item) => !targetCourseIds.has(item.courseId));
    if (removed.length === 0) return [];

    const progress = await client.learningProgress.findMany({
      where: {
        userId: learnerId,
        courseId: { in: removed.map((item) => item.courseId) },
        OR: [
          { status: { in: ['in_progress', 'completed'] } },
          { progressPercent: { gt: 0 } },
          { watchedSeconds: { gt: 0 } },
          { documentProgressPercent: { gt: 0 } },
          { lastAccessedAt: { not: null } },
        ],
      },
      distinct: ['courseId'],
      select: { courseId: true },
    });
    const startedCourseIds = new Set(progress.map((item) => item.courseId));
    const continuous = Boolean(currentTermEndsAt && currentTermEndsAt > at);

    return removed.map((item) => {
      const startedBeforeRemoval = startedCourseIds.has(item.courseId);
      const eligible = continuous && startedBeforeRemoval && item.graceDays > 0;
      const graceStartsAt = eligible ? currentTermEndsAt : null;
      const graceEndsAt = graceStartsAt
        ? new Date(graceStartsAt.getTime() + item.graceDays * 86_400_000)
        : null;
      return {
        courseId: item.courseId,
        title: item.course.title,
        slug: item.course.slug,
        startedBeforeRemoval,
        graceDays: item.graceDays,
        graceStartsAt,
        graceEndsAt,
      };
    });
  }

  persistSnapshots(
    client: Prisma.TransactionClient,
    checkoutIntentId: string,
    learnerId: string,
    removedCourses: RemovedCourseContinuity[],
  ) {
    if (removedCourses.length === 0) return Promise.resolve({ count: 0 });
    return client.membershipRemovedCourseSnapshot.createMany({
      data: removedCourses.map((item) => ({
        checkoutIntentId,
        userId: learnerId,
        courseId: item.courseId,
        courseTitle: item.title,
        courseSlug: item.slug,
        startedBeforeRemoval: item.startedBeforeRemoval,
        graceDays: item.graceDays,
        graceStartsAt: item.graceStartsAt,
        graceEndsAt: item.graceEndsAt,
      })),
      skipDuplicates: true,
    });
  }

  async activateGraceGrants(
    checkoutIntentId: string,
    client: Prisma.TransactionClient,
  ) {
    const snapshots = await client.membershipRemovedCourseSnapshot.findMany({
      where: { checkoutIntentId, graceStartsAt: { not: null }, graceEndsAt: { not: null } },
      orderBy: { courseId: 'asc' },
    });
    for (const snapshot of snapshots) {
      await this.courseAccess.ensureGrant({
        userId: snapshot.userId,
        courseId: snapshot.courseId,
        sourceType: CourseAccessSourceType.membership_grace,
        sourceId: snapshot.id,
        startsAt: snapshot.graceStartsAt!,
        endsAt: snapshot.graceEndsAt!,
      }, client);
    }
    return snapshots.length;
  }

  async listExpiringGrace(learnerId: string, at = new Date()) {
    const nearExpiry = new Date(at.getTime() + 7 * 86_400_000);
    const grants = await this.prisma.courseAccessGrant.findMany({
      where: {
        userId: learnerId,
        sourceType: CourseAccessSourceType.membership_grace,
        status: CourseAccessGrantStatus.active,
        startsAt: { lte: at },
        endsAt: { gt: at, lte: nearExpiry },
      },
      orderBy: [{ endsAt: 'asc' }, { courseId: 'asc' }],
      select: { courseId: true, endsAt: true, course: { select: { title: true, slug: true } } },
    });
    return grants.map((grant) => ({
      courseId: grant.courseId,
      title: grant.course.title,
      slug: grant.course.slug,
      graceEndsAt: grant.endsAt,
    }));
  }

  emergencyRevoke(actorId: string, input: EmergencyMembershipCourseRevocationDto) {
    return this.prisma.$transaction(async (tx) => {
      const learner = await tx.user.findUnique({ where: { id: input.learnerId }, select: { id: true } });
      const course = await tx.course.findUnique({ where: { id: input.courseId }, select: { id: true } });
      if (!learner || !course) throw new NotFoundException('Learner or course not found.');
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM course_access_grants
        WHERE user_id = ${input.learnerId}::uuid
          AND course_id = ${input.courseId}::uuid
          AND source_type IN ('membership'::course_access_source_type, 'membership_grace'::course_access_source_type)
        FOR UPDATE
      `);
      const grants = await tx.courseAccessGrant.findMany({
        where: {
          userId: input.learnerId,
          courseId: input.courseId,
          sourceType: { in: [CourseAccessSourceType.membership, CourseAccessSourceType.membership_grace] },
          status: CourseAccessGrantStatus.active,
        },
        orderBy: { id: 'asc' },
      });
      const reasonCode = `MEMBERSHIP_${input.kind}`;
      for (const grant of grants) {
        await this.courseAccess.revokeGrant({
          userId: grant.userId,
          courseId: grant.courseId,
          sourceType: grant.sourceType,
          sourceId: grant.sourceId,
        }, reasonCode, tx);
      }
      await this.audit.record({
        actorId,
        action: AuditAction.MembershipCourseAccessEmergencyRevoked,
        target: { type: 'course', id: input.courseId },
        metadata: {
          learnerId: input.learnerId,
          kind: input.kind,
          reason: input.reason,
          revokedGrantCount: grants.length,
        },
      }, tx);
      return { revokedGrantCount: grants.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
