import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CourseAccessGrantStatus,
  CourseAccessSourceType,
  CourseStatus,
  CourseVisibility,
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  CourseAccessDecision,
  CourseAccessOperation,
  resolveCourseAccessFacts,
} from './course-access.rules';

export interface CourseAccessRequest {
  user?: AuthenticatedUser;
  courseId: string;
  operation: CourseAccessOperation;
  isPreviewResource?: boolean;
  at?: Date;
}

export interface CourseContentAccessRequest {
  user: AuthenticatedUser;
  courseId: string;
  isPreviewResource: boolean;
  at?: Date;
}

export interface EnsureCourseAccessGrantInput {
  userId: string;
  courseId: string;
  sourceType: CourseAccessSourceType;
  sourceId: string;
  startsAt: Date;
  endsAt?: Date | null;
  graceEndsAt?: Date | null;
}

@Injectable()
export class CourseAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async decide(input: CourseAccessRequest): Promise<CourseAccessDecision> {
    return this.decideWithClient(input, this.prisma);
  }

  async decideWithClient(
    input: CourseAccessRequest,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<CourseAccessDecision> {
    const at = input.at ?? new Date();
    const course = await client.course.findUnique({
      where: { id: input.courseId },
      select: {
        id: true, instructorId: true, deletedAt: true, status: true,
        visibility: true, moderationStatus: true,
      },
    });
    if (!course) {
      return resolveCourseAccessFacts(input.operation, {
        userDeleted: false, courseDeleted: true, isPlatformAdmin: false,
        isOwner: false, moderationClear: false, published: false, archived: false,
        isPublic: false, isPreviewResource: false, hasActiveGrant: false,
        hasGraceGrant: false, hasQualifyingLegacyEnrollment: false,
      });
    }

    const userRecord = input.user
      ? await client.user.findUnique({ where: { id: input.user.id }, select: { id: true, deletedAt: true } })
      : null;
    const isLearner = Boolean(input.user?.roles.includes(RoleName.student));
    let hasActiveGrant = false;
    let hasGraceGrant = false;

    if (input.operation === 'FULL_LEARNING' && input.user && isLearner) {
      const grant = await client.courseAccessGrant.findFirst({
        where: {
          userId: input.user.id, courseId: input.courseId,
          status: CourseAccessGrantStatus.active, startsAt: { lte: at },
          OR: [{ endsAt: null }, { endsAt: { gt: at } }, { graceEndsAt: { gt: at } }],
        },
        orderBy: [{ endsAt: { sort: 'desc', nulls: 'first' } }, { graceEndsAt: 'desc' }, { id: 'asc' }],
        select: { id: true, sourceType: true, endsAt: true, graceEndsAt: true },
      });
      const explicitGrace = grant?.sourceType === CourseAccessSourceType.membership_grace;
      hasActiveGrant = Boolean(grant && !explicitGrace && (grant.endsAt === null || grant.endsAt > at));
      hasGraceGrant = Boolean(grant && (explicitGrace || (!hasActiveGrant && grant.graceEndsAt && grant.graceEndsAt > at)));
    }

    return resolveCourseAccessFacts(input.operation, {
      userDeleted: Boolean(input.user && (!userRecord || userRecord.deletedAt)),
      courseDeleted: Boolean(course.deletedAt),
      isPlatformAdmin: Boolean(input.user?.roles.includes(RoleName.platform_admin)),
      isOwner: input.user?.id === course.instructorId,
      moderationClear: course.moderationStatus === ModerationStatus.clear,
      published: course.status === CourseStatus.published,
      archived: course.status === CourseStatus.archived,
      isPublic: course.visibility === CourseVisibility.public,
      isPreviewResource: input.isPreviewResource === true,
      hasActiveGrant,
      hasGraceGrant,
      hasQualifyingLegacyEnrollment: false,
    });
  }

  async require(input: CourseAccessRequest): Promise<CourseAccessDecision> {
    const decision = await this.decide(input);
    if (!decision.allowed) throw new NotFoundException('Course not found');
    return decision;
  }

  async decideContent(input: CourseContentAccessRequest): Promise<CourseAccessDecision> {
    const manage = await this.decide({ ...input, operation: 'MANAGE' });
    if (manage.allowed) return manage;
    if (input.isPreviewResource) {
      const preview = await this.decide({ ...input, operation: 'PUBLIC_PREVIEW' });
      if (preview.allowed) return preview;
    }
    return this.decide({ ...input, operation: 'FULL_LEARNING' });
  }

  async requireContent(input: CourseContentAccessRequest): Promise<CourseAccessDecision> {
    const decision = await this.decideContent(input);
    if (!decision.allowed) throw new NotFoundException('Course not found');
    return decision;
  }

  async ensureGrant(
    input: EnsureCourseAccessGrantInput,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const endsAt = input.endsAt ?? null;
    const graceEndsAt = input.graceEndsAt ?? null;
    if (!input.sourceId || input.sourceId.length > 128
      || (endsAt && endsAt <= input.startsAt)
      || (graceEndsAt && (!endsAt || graceEndsAt < endsAt))) {
      throw new BadRequestException('Invalid course access grant source or window.');
    }
    await client.courseAccessGrant.createMany({
      data: [{
        userId: input.userId, courseId: input.courseId,
        sourceType: input.sourceType, sourceId: input.sourceId,
        startsAt: input.startsAt, endsAt, graceEndsAt,
      }],
      skipDuplicates: true,
    });
    await client.enrollment.upsert({
      where: { userId_courseId: { userId: input.userId, courseId: input.courseId } },
      create: { userId: input.userId, courseId: input.courseId, status: 'active' },
      update: {},
      select: { id: true },
    });
    const lessons = await client.lesson.findMany({
      where: { courseId: input.courseId, deletedAt: null }, select: { id: true },
    });
    if (lessons.length > 0) {
      await client.learningProgress.createMany({
        data: lessons.map((lesson) => ({
          userId: input.userId, courseId: input.courseId, lessonId: lesson.id,
          status: 'not_started', progressPercent: 0,
        })),
        skipDuplicates: true,
      });
    }
    return client.courseAccessGrant.findUnique({
      where: {
        userId_courseId_sourceType_sourceId: {
          userId: input.userId, courseId: input.courseId,
          sourceType: input.sourceType, sourceId: input.sourceId,
        },
      },
    });
  }

  async revokeGrant(
    identity: Pick<EnsureCourseAccessGrantInput, 'userId' | 'courseId' | 'sourceType' | 'sourceId'>,
    reason: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    if (!reason.trim() || reason.length > 120) {
      throw new BadRequestException('Invalid course access revocation reason.');
    }
    const grant = await client.courseAccessGrant.findUnique({
      where: { userId_courseId_sourceType_sourceId: identity },
    });
    if (!grant || grant.status === CourseAccessGrantStatus.revoked) return grant;
    return client.courseAccessGrant.update({
      where: { id: grant.id },
      data: { status: CourseAccessGrantStatus.revoked, revokedAt: new Date(), revocationReason: reason },
    });
  }
}
