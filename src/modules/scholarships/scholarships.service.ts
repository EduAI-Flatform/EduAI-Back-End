import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseAccessSourceType,
  Prisma,
  ScholarshipApplicationStatus,
  ScholarshipBenefitKind,
  ScholarshipStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { MAX_UNPAGINATED_API_ITEMS } from '../../common/performance/list-limits';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAccessService } from '../access/course-access.service';
import { ApplyScholarshipDto } from './dto/apply-scholarship.dto';
import { CreateScholarshipDto } from './dto/create-scholarship.dto';
import { ListScholarshipsQueryDto } from './dto/list-scholarships-query.dto';
import { UpdateScholarshipDto } from './dto/update-scholarship.dto';
import {
  evaluateScholarshipEligibility,
  type ScholarshipEligibilityReason,
  type ScholarshipPolicy,
} from '../../../prisma/scholarship-contract';

const scholarshipSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  applicationMode: true,
  benefitKind: true,
  benefitValue: true,
  currency: true,
  startsAt: true,
  endsAt: true,
  quota: true,
  awardedCount: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  courseScopes: { select: { courseId: true } },
  categoryScopes: { select: { categorySlug: true } },
  eligibleUsers: { select: { userId: true } },
} satisfies Prisma.ScholarshipCampaignSelect;

const applicationSelect = {
  id: true,
  scholarshipId: true,
  userId: true,
  courseId: true,
  status: true,
  decisionReason: true,
  appliedAt: true,
  updatedAt: true,
  award: {
    select: {
      id: true,
      benefitKind: true,
      benefitValue: true,
      currency: true,
      awardedAt: true,
      revokedAt: true,
    },
  },
} satisfies Prisma.ScholarshipApplicationSelect;

type ScholarshipRecord = Prisma.ScholarshipCampaignGetPayload<{
  select: typeof scholarshipSelect;
}>;
type ApplicationRecord = Prisma.ScholarshipApplicationGetPayload<{
  select: typeof applicationSelect;
}>;

export interface ScholarshipResponse {
  id: string;
  title: string;
  description: string | null;
  status: ScholarshipStatus;
  applicationMode: string;
  benefitKind: ScholarshipBenefitKind;
  benefitValue: number;
  currency: string | null;
  startsAt: Date;
  endsAt: Date;
  quota: number | null;
  awardedCount: number;
  courseIds: string[];
  categorySlugs: string[];
  eligibleUserIds: string[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScholarshipEligibilityResponse {
  scholarshipId: string;
  courseId: string;
  eligible: boolean;
  reason: ScholarshipEligibilityReason;
}

export interface ScholarshipApplicationResponse {
  id: string;
  scholarshipId: string;
  userId: string;
  courseId: string;
  status: ScholarshipApplicationStatus;
  decisionReason: string | null;
  appliedAt: Date;
  updatedAt: Date;
  idempotent: boolean;
  award: ApplicationRecord['award'];
}

export interface ScholarshipPage {
  items: ScholarshipResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ScholarshipApplicationPage {
  items: ScholarshipApplicationResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class ScholarshipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly courseAccess: CourseAccessService,
  ) {}

  async createScholarship(
    actorId: string,
    input: CreateScholarshipDto,
  ): Promise<ScholarshipResponse> {
    const normalized = this.normalizeCreateInput(input);
    this.assertPolicy(normalized);
    await this.assertScopeTargets(normalized.courseIds, normalized.eligibleUserIds);

    const created = await this.prisma.$transaction(async (tx) => {
      const scholarship = await tx.scholarshipCampaign.create({
        data: {
          title: normalized.title,
          description: normalized.description,
          status: ScholarshipStatus.draft,
          applicationMode: normalized.applicationMode,
          benefitKind: normalized.benefitKind,
          benefitValue: normalized.benefitValue,
          currency: normalized.currency,
          startsAt: new Date(normalized.startsAt),
          endsAt: new Date(normalized.endsAt),
          quota: normalized.quota,
          createdById: actorId,
          courseScopes: { create: normalized.courseIds.map((courseId) => ({ courseId })) },
          categoryScopes: { create: normalized.categorySlugs.map((categorySlug) => ({ categorySlug })) },
          eligibleUsers: { create: normalized.eligibleUserIds.map((userId) => ({ userId })) },
        },
        select: scholarshipSelect,
      });
      await this.auditService.record(
        {
          actorId,
          action: AuditAction.ScholarshipCreated,
          target: { type: 'scholarship_campaign', id: scholarship.id },
          metadata: { title: scholarship.title, status: scholarship.status },
        },
        tx,
      );
      return scholarship;
    });
    return this.toScholarshipResponse(created);
  }

  async getScholarship(id: string): Promise<ScholarshipResponse> {
    const scholarship = await this.prisma.scholarshipCampaign.findUnique({
      where: { id },
      select: scholarshipSelect,
    });
    if (!scholarship) throw new NotFoundException('Scholarship campaign not found');
    return this.toScholarshipResponse(scholarship);
  }

  async listScholarships(query: ListScholarshipsQueryDto): Promise<ScholarshipPage> {
    const where: Prisma.ScholarshipCampaignWhereInput = query.status
      ? { status: query.status }
      : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.scholarshipCampaign.count({ where }),
      this.prisma.scholarshipCampaign.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: scholarshipSelect,
      }),
    ]);
    return {
      items: items.map((item) => this.toScholarshipResponse(item)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async updateScholarship(
    actorId: string,
    id: string,
    input: UpdateScholarshipDto,
  ): Promise<ScholarshipResponse> {
    const current = await this.prisma.scholarshipCampaign.findUnique({
      where: { id },
      select: scholarshipSelect,
    });
    if (!current) throw new NotFoundException('Scholarship campaign not found');
    const normalized = this.normalizeUpdateInput(current, input);
    this.assertPolicy(normalized);
    if (current.awardedCount > 0 && this.changesEconomicPolicy(input)) {
      throw new ConflictException('Economic scholarship policy cannot change after awards; pause or close it instead');
    }
    await this.assertScopeTargets(normalized.courseIds, normalized.eligibleUserIds);

    const updated = await this.prisma.$transaction(async (tx) => {
      const scholarship = await tx.scholarshipCampaign.update({
        where: { id },
        data: {
          title: normalized.title,
          description: normalized.description,
          status: normalized.status,
          applicationMode: normalized.applicationMode,
          benefitKind: normalized.benefitKind,
          benefitValue: normalized.benefitValue,
          currency: normalized.currency,
          startsAt: new Date(normalized.startsAt),
          endsAt: new Date(normalized.endsAt),
          quota: normalized.quota,
          courseScopes: { deleteMany: {}, create: normalized.courseIds.map((courseId) => ({ courseId })) },
          categoryScopes: { deleteMany: {}, create: normalized.categorySlugs.map((categorySlug) => ({ categorySlug })) },
          eligibleUsers: { deleteMany: {}, create: normalized.eligibleUserIds.map((userId) => ({ userId })) },
        },
        select: scholarshipSelect,
      });
      await this.auditService.record(
        {
          actorId,
          action: AuditAction.ScholarshipUpdated,
          target: { type: 'scholarship_campaign', id },
          metadata: { title: scholarship.title, status: scholarship.status },
        },
        tx,
      );
      return scholarship;
    });
    return this.toScholarshipResponse(updated);
  }

  async preview(userId: string, id: string, courseId: string): Promise<ScholarshipEligibilityResponse> {
    const scholarship = await this.prisma.scholarshipCampaign.findUnique({ where: { id }, select: scholarshipSelect });
    if (!scholarship) throw new NotFoundException('Scholarship campaign not found');
    const course = await this.findEligibleCourse(this.prisma, courseId);
    const existing = await this.prisma.scholarshipApplication.findUnique({
      where: { scholarshipId_userId_courseId: { scholarshipId: id, userId, courseId } },
      select: { id: true },
    });
    return this.toEligibilityResponse(
      scholarship,
      course.id,
      evaluateScholarshipEligibility(this.toPolicy(scholarship), {
        now: new Date().toISOString(),
        userId,
        courseId: course.id,
        categorySlug: course.categorySlug,
        alreadyApplied: Boolean(existing),
      }),
    );
  }

  async listEligible(userId: string, courseId: string): Promise<ScholarshipResponse[]> {
    const course = await this.findEligibleCourse(this.prisma, courseId);
    const campaigns = await this.prisma.scholarshipCampaign.findMany({
      where: {
        status: ScholarshipStatus.active,
        startsAt: { lte: new Date() },
        endsAt: { gt: new Date() },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: MAX_UNPAGINATED_API_ITEMS,
      select: scholarshipSelect,
    });
    const existing = await this.prisma.scholarshipApplication.findMany({
      where: {
        userId,
        courseId,
        scholarshipId: { in: campaigns.map(({ id }) => id) },
      },
      select: { scholarshipId: true },
    });
    const existingIds = new Set(existing.map(({ scholarshipId }) => scholarshipId));
    return campaigns
      .filter((campaign) => evaluateScholarshipEligibility(this.toPolicy(campaign), {
        now: new Date().toISOString(),
        userId,
        courseId: course.id,
        categorySlug: course.categorySlug,
        alreadyApplied: existingIds.has(campaign.id),
      }).eligible)
      .map((campaign) => this.toScholarshipResponse(campaign));
  }

  async apply(
    userId: string,
    scholarshipId: string,
    input: ApplyScholarshipDto,
  ): Promise<ScholarshipApplicationResponse> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "scholarship_campaigns" WHERE id = ${scholarshipId} FOR UPDATE
      `;
      const scholarship = await tx.scholarshipCampaign.findUnique({ where: { id: scholarshipId }, select: scholarshipSelect });
      if (!scholarship) throw new NotFoundException('Scholarship campaign not found');
      const existing = await tx.scholarshipApplication.findUnique({
        where: { scholarshipId_userId_courseId: { scholarshipId, userId, courseId: input.courseId } },
        select: applicationSelect,
      });
      if (existing) {
        await this.ensureCourseAccessAward(existing, tx);
        return this.toApplicationResponse(existing, true);
      }

      const course = await this.findEligibleCourse(tx, input.courseId);
      const decision = evaluateScholarshipEligibility(this.toPolicy(scholarship), {
        now: new Date().toISOString(),
        userId,
        courseId: course.id,
        categorySlug: course.categorySlug,
        alreadyApplied: false,
      });
      if (!decision.eligible) this.throwDecision(decision.reason);

      const application = await tx.scholarshipApplication.create({
        data: {
          scholarshipId,
          userId,
          courseId: course.id,
          status: ScholarshipApplicationStatus.awarded,
          award: {
            create: {
              scholarshipId,
              userId,
              courseId: course.id,
              benefitKind: scholarship.benefitKind,
              benefitValue: scholarship.benefitValue,
              currency: scholarship.currency,
            },
          },
        },
        select: applicationSelect,
      });
      await this.ensureCourseAccessAward(application, tx);
      await tx.scholarshipCampaign.update({ where: { id: scholarshipId }, data: { awardedCount: { increment: 1 } } });
      await this.auditService.record(
        {
          actorId: userId,
          action: AuditAction.ScholarshipApplied,
          target: { type: 'scholarship_application', id: application.id },
          metadata: { scholarshipId, courseId: course.id, status: application.status },
        },
        tx,
      );
      return this.toApplicationResponse(application, false);
    });
  }

  private async ensureCourseAccessAward(
    application: ApplicationRecord,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (application.award?.benefitKind !== ScholarshipBenefitKind.course_access) return;
    await this.courseAccess.ensureGrant({
      userId: application.userId,
      courseId: application.courseId,
      sourceType: CourseAccessSourceType.scholarship,
      sourceId: application.award.id,
      startsAt: application.award.awardedAt,
    }, tx);
  }

  async listApplications(
    query: ListScholarshipsQueryDto,
    scholarshipId?: string,
    userId?: string,
  ): Promise<ScholarshipApplicationPage> {
    const where: Prisma.ScholarshipApplicationWhereInput = {
      scholarshipId,
      userId,
      status: query.applicationStatus,
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.scholarshipApplication.count({ where }),
      this.prisma.scholarshipApplication.findMany({
        where,
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: applicationSelect,
      }),
    ]);
    return {
      items: items.map((item) => this.toApplicationResponse(item, false)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  private async findEligibleCourse(
    client: PrismaService | Prisma.TransactionClient,
    courseId: string,
  ) {
    const course = await client.course.findFirst({
      where: { id: courseId, status: 'published', visibility: 'public', deletedAt: null },
      select: { id: true, categorySlug: true },
    });
    if (!course) throw new NotFoundException('Published course not found');
    return course;
  }

  private toPolicy(scholarship: ScholarshipRecord): ScholarshipPolicy {
    return {
      status: scholarship.status,
      applicationMode: scholarship.applicationMode,
      benefitKind: scholarship.benefitKind,
      benefitValue: scholarship.benefitValue,
      currency: scholarship.currency,
      startsAt: scholarship.startsAt.toISOString(),
      endsAt: scholarship.endsAt.toISOString(),
      quota: scholarship.quota,
      awardedCount: scholarship.awardedCount,
      courseIds: scholarship.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: scholarship.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: scholarship.eligibleUsers.map(({ userId }) => userId),
    };
  }

  private toScholarshipResponse(record: ScholarshipRecord): ScholarshipResponse {
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      status: record.status,
      applicationMode: record.applicationMode,
      benefitKind: record.benefitKind,
      benefitValue: record.benefitValue,
      currency: record.currency,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      quota: record.quota,
      awardedCount: record.awardedCount,
      courseIds: record.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: record.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: record.eligibleUsers.map(({ userId }) => userId),
      createdById: record.createdById,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toEligibilityResponse(record: ScholarshipRecord, courseId: string, decision: { eligible: boolean; reason: ScholarshipEligibilityReason }): ScholarshipEligibilityResponse {
    return { scholarshipId: record.id, courseId, ...decision };
  }

  private toApplicationResponse(record: ApplicationRecord, idempotent: boolean): ScholarshipApplicationResponse {
    return { ...record, idempotent };
  }

  private normalizeCreateInput(input: CreateScholarshipDto) {
    return {
      title: input.title.trim(),
      description: input.description?.trim() || null,
      applicationMode: input.applicationMode,
      benefitKind: input.benefitKind,
      benefitValue: input.benefitValue,
      currency: input.currency?.toUpperCase() || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      quota: input.quota ?? null,
      courseIds: [...new Set(input.courseIds ?? [])],
      categorySlugs: [...new Set((input.categorySlugs ?? []).map((value) => value.toLowerCase()))],
      eligibleUserIds: [...new Set(input.eligibleUserIds ?? [])],
      status: ScholarshipStatus.draft,
    };
  }

  private normalizeUpdateInput(current: ScholarshipRecord, input: UpdateScholarshipDto) {
    return {
      title: input.title?.trim() ?? current.title,
      description: input.description === undefined ? current.description : input.description?.trim() || null,
      applicationMode: input.applicationMode ?? current.applicationMode,
      benefitKind: input.benefitKind ?? current.benefitKind,
      benefitValue: input.benefitValue ?? current.benefitValue,
      currency: input.currency === undefined ? current.currency : input.currency?.toUpperCase() || null,
      startsAt: input.startsAt ?? current.startsAt.toISOString(),
      endsAt: input.endsAt ?? current.endsAt.toISOString(),
      quota: input.quota === undefined ? current.quota : input.quota,
      courseIds: input.courseIds ?? current.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: input.categorySlugs ?? current.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: input.eligibleUserIds ?? current.eligibleUsers.map(({ userId }) => userId),
      status: input.status ?? current.status,
    };
  }

  private assertPolicy(input: {
    title: string; benefitKind: ScholarshipBenefitKind; benefitValue: number;
    currency: string | null; startsAt: string; endsAt: string; quota: number | null;
  }): void {
    if (!input.title) throw new BadRequestException('Scholarship title is required');
    const start = Date.parse(input.startsAt);
    const end = Date.parse(input.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new BadRequestException('Scholarship dates must be valid and ordered');
    }
    if (input.quota !== null && input.quota < 1) throw new BadRequestException('Scholarship quota must be positive');
    if (input.benefitKind === ScholarshipBenefitKind.percentage_discount && (input.benefitValue < 1 || input.benefitValue > 100)) {
      throw new BadRequestException('Scholarship percentage benefit must be between 1 and 100');
    }
    if (input.benefitKind === ScholarshipBenefitKind.fixed_credit && input.benefitValue < 1) {
      throw new BadRequestException('Scholarship fixed benefit must be positive');
    }
    if (input.benefitKind !== ScholarshipBenefitKind.course_access && !input.currency) {
      throw new BadRequestException('Scholarship monetary benefits require a currency');
    }
    if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) {
      throw new BadRequestException('Scholarship currency must be ISO 4217');
    }
  }

  private async assertScopeTargets(courseIds: string[], userIds: string[]): Promise<void> {
    const [courses, users] = await Promise.all([
      this.prisma.course.count({ where: { id: { in: courseIds } } }),
      this.prisma.user.count({ where: { id: { in: userIds }, deletedAt: null } }),
    ]);
    if (courses !== courseIds.length) throw new BadRequestException('Scholarship course scope contains an unknown course');
    if (users !== userIds.length) throw new BadRequestException('Scholarship user eligibility contains an unknown user');
  }

  private changesEconomicPolicy(input: UpdateScholarshipDto): boolean {
    return ['applicationMode', 'benefitKind', 'benefitValue', 'currency', 'startsAt', 'endsAt', 'quota', 'courseIds', 'categorySlugs', 'eligibleUserIds']
      .some((field) => Object.prototype.hasOwnProperty.call(input, field));
  }

  private throwDecision(reason: ScholarshipEligibilityReason): never {
    throw new BadRequestException({ error: reason, message: 'Scholarship is not eligible' });
  }
}
