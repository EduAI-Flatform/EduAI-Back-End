import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MembershipPlanStatus,
  MembershipPlanVersionStatus,
  Prisma,
  ServiceEntitlementResetPeriod,
  ServiceEntitlementValueType,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateMembershipPlanDto,
  CreateMembershipPlanVersionDto,
  ListMembershipPlansQueryDto,
  ListMembershipAvailableCoursesQueryDto,
  MembershipDurationInputDto,
  CreateServiceEntitlementDefinitionDto,
  ConfigureMembershipPlanEntitlementDto,
  ListServiceEntitlementDefinitionsQueryDto,
  ConfigureMembershipIncludedCourseDto,
} from './dto/membership-plan.dto';
import { calculateDurationPrice } from './membership.rules';
import { normalizeEntitlementValue } from './service-entitlement.rules';

const versionInclude = {
  durationOptions: { orderBy: [{ displayOrder: 'asc' as const }, { id: 'asc' as const }] },
  serviceEntitlements: {
    orderBy: [{ definition: { displayOrder: 'asc' as const } }, { id: 'asc' as const }],
    include: { definition: true },
  },
  includedCourses: {
    orderBy: [{ course: { title: 'asc' as const } }, { id: 'asc' as const }],
    include: { course: { select: { id: true, title: true, slug: true } } },
  },
} satisfies Prisma.MembershipPlanVersionInclude;
const planInclude = {
  versions: {
    orderBy: { versionNumber: 'desc' as const },
    include: versionInclude,
  },
} satisfies Prisma.MembershipPlanInclude;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
type PlanRecord = Prisma.MembershipPlanGetPayload<{ include: typeof planInclude }>;
type VersionRecord = Prisma.MembershipPlanVersionGetPayload<{ include: typeof versionInclude }>;

interface NormalizedVersion {
  displayName: string;
  description: string | null;
  baseMonthlyPriceAmountMinor: bigint;
  currency: 'VND';
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  durations: Array<{
    months: number;
    priceAmountMinor: bigint | null;
    discountPercent: number | null;
    displayOrder: number;
  }>;
}

@Injectable()
export class MembershipAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  createPlan(actorId: string, input: CreateMembershipPlanDto) {
    const version = this.normalizeVersion(input);
    const code = input.code.trim().toUpperCase();
    return this.runSerializable(async (tx) => {
      const plan = await tx.membershipPlan.create({
        data: {
          code,
          versions: {
            create: {
              versionNumber: 1,
              ...this.versionCreateData(actorId, version),
            },
          },
        },
        include: planInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.MembershipPlanCreated,
          target: { type: 'membership_plan', id: plan.id },
          metadata: { code, initialVersionNumber: 1 },
        },
        tx,
      );
      return this.planResponse(plan);
    });
  }

  async createEntitlementDefinition(actorId: string, input: CreateServiceEntitlementDefinitionDto) {
    const valueType = input.valueType.toLowerCase() as ServiceEntitlementValueType;
    const resetPeriod = input.resetPeriod.toLowerCase() as ServiceEntitlementResetPeriod;
    try {
      normalizeEntitlementValue(
        valueType,
        resetPeriod,
        valueType === ServiceEntitlementValueType.boolean ? false : null,
        valueType === ServiceEntitlementValueType.metered ? 1n : null,
      );
    } catch {
      throw new BadRequestException('Service entitlement reset period does not match its value type.');
    }
    try {
      const definition = await this.prisma.$transaction(async (tx) => {
        const created = await tx.serviceEntitlementDefinition.create({
          data: {
            code: input.code.trim().toUpperCase(), valueType, resetPeriod,
            displayName: input.displayName.trim(), description: input.description?.trim() || null,
            unitLabel: input.unitLabel?.trim() || null, displayOrder: input.displayOrder,
            createdById: actorId,
          },
        });
        await this.audit.record({
          actorId, action: AuditAction.ServiceEntitlementDefinitionCreated,
          target: { type: 'service_entitlement_definition', id: created.id },
          metadata: { code: created.code, valueType: created.valueType, resetPeriod: created.resetPeriod },
        }, tx);
        return created;
      });
      return this.entitlementDefinitionResponse(definition);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Service entitlement code already exists.');
      }
      throw error;
    }
  }

  async listEntitlementDefinitions(query: ListServiceEntitlementDefinitionsQueryDto) {
    const where: Prisma.ServiceEntitlementDefinitionWhereInput = query.search ? {
      OR: [
        { code: { contains: query.search, mode: 'insensitive' } },
        { displayName: { contains: query.search, mode: 'insensitive' } },
      ],
    } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.serviceEntitlementDefinition.count({ where }),
      this.prisma.serviceEntitlementDefinition.findMany({
        where, orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    return {
      items: items.map((item) => this.entitlementDefinitionResponse(item)),
      page: query.page, pageSize: query.pageSize, total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  configurePlanEntitlement(
    actorId: string,
    versionId: string,
    input: ConfigureMembershipPlanEntitlementDto,
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`);
      const version = await tx.membershipPlanVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new NotFoundException('Membership plan version not found.');
      if (version.status !== MembershipPlanVersionStatus.draft) {
        throw new ConflictException('Published membership entitlements are immutable.');
      }
      const definition = await tx.serviceEntitlementDefinition.findUnique({ where: { id: input.definitionId } });
      if (!definition) throw new NotFoundException('Service entitlement definition not found.');
      let quota: bigint | null = null;
      if (input.quota) quota = this.parseAmountMinor(input.quota);
      const booleanValue = input.booleanValue ?? null;
      try {
        normalizeEntitlementValue(
          definition.valueType,
          definition.resetPeriod,
          booleanValue,
          quota,
        );
      } catch {
        throw new BadRequestException('Configured entitlement value does not match its stable definition.');
      }
      try {
        const configured = await tx.membershipPlanEntitlement.create({
          data: {
            versionId, definitionId: definition.id,
            valueType: definition.valueType, resetPeriod: definition.resetPeriod,
            booleanValue, quota, createdById: actorId,
          },
          include: { definition: true },
        });
        await this.audit.record({
          actorId, action: AuditAction.MembershipPlanEntitlementConfigured,
          target: { type: 'membership_plan_entitlement', id: configured.id },
          metadata: { versionId, code: definition.code, valueType: definition.valueType },
        }, tx);
        return this.planEntitlementResponse(configured);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Service entitlement is already configured for this version.');
        }
        throw error;
      }
    });
  }

  configureIncludedCourse(
    actorId: string,
    versionId: string,
    input: ConfigureMembershipIncludedCourseDto,
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`);
      const version = await tx.membershipPlanVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new NotFoundException('Membership plan version not found.');
      if (version.status !== MembershipPlanVersionStatus.draft) {
        throw new ConflictException('Published membership course inclusions are immutable.');
      }
      const course = await tx.course.findFirst({
        where: { id: input.courseId, deletedAt: null, status: 'published', moderationStatus: 'clear' },
        select: { id: true, title: true, slug: true },
      });
      if (!course) throw new NotFoundException('Available course not found.');
      try {
        const included = await tx.membershipPlanIncludedCourse.create({
          data: { versionId, courseId: course.id, graceDays: input.graceDays, createdById: actorId },
          include: { course: { select: { id: true, title: true, slug: true } } },
        });
        await this.audit.record({
          actorId, action: AuditAction.MembershipPlanCourseIncluded,
          target: { type: 'membership_plan_included_course', id: included.id },
          metadata: { versionId, courseId: course.id, graceDays: input.graceDays },
        }, tx);
        return this.includedCourseResponse(included);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Course is already included in this membership version.');
        }
        throw error;
      }
    });
  }

  async listPlans(query: ListMembershipPlansQueryDto) {
    const where: Prisma.MembershipPlanWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' as const } },
              {
                versions: {
                  some: { displayName: { contains: query.search, mode: 'insensitive' as const } },
                },
              },
            ],
          }
        : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.membershipPlan.count({ where }),
      this.prisma.membershipPlan.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: planInclude,
      }),
    ]);
    return {
      items: items.map((plan) => this.planResponse(plan)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async listAvailableCourses(query: ListMembershipAvailableCoursesQueryDto) {
    const where: Prisma.CourseWhereInput = {
      deletedAt: null,
      status: 'published',
      moderationStatus: 'clear',
      ...(query.search ? {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, title: true, slug: true, visibility: true },
      }),
    ]);
    return {
      items: items.map((course) => ({ ...course, visibility: course.visibility.toUpperCase() })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  createVersion(
    actorId: string,
    planId: string,
    input: CreateMembershipPlanVersionDto,
  ) {
    const normalized = this.normalizeVersion(input);
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plans WHERE id = ${planId}::uuid FOR UPDATE`);
      const plan = await tx.membershipPlan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException('Membership plan not found.');
      if (plan.status !== MembershipPlanStatus.active) {
        throw new ConflictException('Archived membership plans cannot receive versions.');
      }
      const latest = await tx.membershipPlanVersion.aggregate({
        where: { planId },
        _max: { versionNumber: true },
      });
      const versionNumber = (latest._max.versionNumber ?? 0) + 1;
      const created = await tx.membershipPlanVersion.create({
        data: {
          planId,
          versionNumber,
          ...this.versionCreateData(actorId, normalized),
        },
        include: versionInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.MembershipPlanVersionCreated,
          target: { type: 'membership_plan_version', id: created.id },
          metadata: { planId, versionNumber },
        },
        tx,
      );
      return this.versionResponse(created);
    });
  }

  publishVersion(actorId: string, versionId: string) {
    return this.transitionVersion(actorId, versionId, 'publish');
  }

  archiveVersion(actorId: string, versionId: string) {
    return this.transitionVersion(actorId, versionId, 'archive');
  }

  archivePlan(actorId: string, planId: string) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plans WHERE id = ${planId}::uuid FOR UPDATE`);
      const current = await tx.membershipPlan.findUnique({ where: { id: planId } });
      if (!current) throw new NotFoundException('Membership plan not found.');
      if (current.status === MembershipPlanStatus.archived) {
        throw new ConflictException('Membership plan is already archived.');
      }
      const plan = await tx.membershipPlan.update({
        where: { id: planId },
        data: { status: MembershipPlanStatus.archived, archivedAt: new Date() },
        include: planInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.MembershipPlanArchived,
          target: { type: 'membership_plan', id: planId },
          metadata: { code: plan.code },
        },
        tx,
      );
      return this.planResponse(plan);
    });
  }

  private transitionVersion(
    actorId: string,
    versionId: string,
    transition: 'publish' | 'archive',
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`);
      const current = await tx.membershipPlanVersion.findUnique({
        where: { id: versionId },
        include: versionInclude,
      });
      if (!current) throw new NotFoundException('Membership plan version not found.');
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM membership_plans WHERE id = ${current.planId}::uuid FOR UPDATE`,
      );
      const expected = transition === 'publish'
        ? MembershipPlanVersionStatus.draft
        : MembershipPlanVersionStatus.published;
      if (current.status !== expected) {
        throw new ConflictException(`Membership version cannot ${transition} from its current state.`);
      }
      if (transition === 'publish') {
        const plan = await tx.membershipPlan.findUnique({ where: { id: current.planId } });
        if (!plan || plan.status !== MembershipPlanStatus.active) {
          throw new ConflictException('Only active membership plans can publish versions.');
        }
      }
      const now = new Date();
      const updated = await tx.membershipPlanVersion.update({
        where: { id: versionId },
        data: transition === 'publish'
          ? {
              status: MembershipPlanVersionStatus.published,
              publishedById: actorId,
              publishedAt: now,
            }
          : {
              status: MembershipPlanVersionStatus.archived,
              archivedById: actorId,
              archivedAt: now,
            },
        include: versionInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: transition === 'publish'
            ? AuditAction.MembershipPlanVersionPublished
            : AuditAction.MembershipPlanVersionArchived,
          target: { type: 'membership_plan_version', id: versionId },
          metadata: { planId: current.planId, versionNumber: current.versionNumber },
        },
        tx,
      );
      return this.versionResponse(updated);
    });
  }

  private normalizeVersion(input: CreateMembershipPlanVersionDto): NormalizedVersion {
    const salesStartAt = input.salesStartAt ? new Date(input.salesStartAt) : null;
    const salesEndAt = input.salesEndAt ? new Date(input.salesEndAt) : null;
    if (salesStartAt && salesEndAt && salesEndAt <= salesStartAt) {
      throw new BadRequestException('Membership sales end must follow its start.');
    }
    const months = new Set<number>();
    const displayOrders = new Set<number>();
    const durations = input.durations
      .map((duration) => this.normalizeDuration(duration))
      .sort((left, right) => left.displayOrder - right.displayOrder);
    for (const duration of durations) {
      if (months.has(duration.months) || displayOrders.has(duration.displayOrder)) {
        throw new BadRequestException('Membership durations and display order must be unique.');
      }
      months.add(duration.months);
      displayOrders.add(duration.displayOrder);
    }
    return {
      displayName: input.displayName.trim(),
      description: input.description?.trim() || null,
      baseMonthlyPriceAmountMinor: this.parseAmountMinor(
        input.baseMonthlyPriceAmountMinor,
      ),
      currency: 'VND',
      salesStartAt,
      salesEndAt,
      durations,
    };
  }

  private normalizeDuration(duration: MembershipDurationInputDto) {
    const priceAmountMinor = duration.priceAmountMinor === undefined
      ? null
      : this.parseAmountMinor(duration.priceAmountMinor);
    const discountPercent = duration.discountPercent ?? null;
    calculateDurationPrice({
      baseMonthlyPriceAmountMinor: 0n,
      months: duration.months,
      priceAmountMinor,
      discountPercent,
    });
    return {
      months: duration.months,
      priceAmountMinor,
      discountPercent,
      displayOrder: duration.displayOrder,
    };
  }

  private parseAmountMinor(value: string): bigint {
    const amount = BigInt(value);
    if (amount > POSTGRES_BIGINT_MAX) {
      throw new BadRequestException('Membership amount exceeds the supported range.');
    }
    return amount;
  }

  private versionCreateData(actorId: string, input: NormalizedVersion) {
    return {
      displayName: input.displayName,
      description: input.description,
      baseMonthlyPriceAmountMinor: input.baseMonthlyPriceAmountMinor,
      currency: input.currency,
      salesStartAt: input.salesStartAt,
      salesEndAt: input.salesEndAt,
      createdById: actorId,
      durationOptions: { create: input.durations },
    };
  }

  private planResponse(plan: PlanRecord) {
    return {
      id: plan.id,
      code: plan.code,
      status: plan.status.toUpperCase(),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      archivedAt: plan.archivedAt,
      versions: plan.versions.map((version) => this.versionResponse(version)),
    };
  }

  private versionResponse(version: VersionRecord) {
    return {
      id: version.id,
      planId: version.planId,
      versionNumber: version.versionNumber,
      displayName: version.displayName,
      description: version.description,
      baseMonthlyPriceAmountMinor: version.baseMonthlyPriceAmountMinor.toString(),
      currency: version.currency,
      salesStartAt: version.salesStartAt,
      salesEndAt: version.salesEndAt,
      status: version.status.toUpperCase(),
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      archivedAt: version.archivedAt,
      durationOptions: version.durationOptions.map((duration) => ({
        id: duration.id,
        months: duration.months,
        pricingMode: duration.priceAmountMinor === null ? 'DISCOUNT' : 'FIXED_PRICE',
        priceAmountMinor: duration.priceAmountMinor?.toString() ?? null,
        discountPercent: duration.discountPercent,
        effectivePriceAmountMinor: calculateDurationPrice({
          baseMonthlyPriceAmountMinor: version.baseMonthlyPriceAmountMinor,
          months: duration.months,
          priceAmountMinor: duration.priceAmountMinor,
          discountPercent: duration.discountPercent,
        }).toString(),
        currency: version.currency,
        displayOrder: duration.displayOrder,
      })),
      serviceEntitlements: version.serviceEntitlements.map((item) => this.planEntitlementResponse(item)),
      includedCourses: version.includedCourses.map((item) => this.includedCourseResponse(item)),
    };
  }

  private entitlementDefinitionResponse(definition: {
    id: string; code: string; valueType: ServiceEntitlementValueType;
    resetPeriod: ServiceEntitlementResetPeriod; displayName: string;
    description: string | null; unitLabel: string | null; displayOrder: number;
  }) {
    return {
      id: definition.id, code: definition.code,
      valueType: definition.valueType.toUpperCase(), resetPeriod: definition.resetPeriod.toUpperCase(),
      displayName: definition.displayName, description: definition.description,
      unitLabel: definition.unitLabel, displayOrder: definition.displayOrder,
    };
  }

  private planEntitlementResponse(item: {
    id: string; versionId: string; booleanValue: boolean | null; quota: bigint | null;
    definition: Parameters<MembershipAdminService['entitlementDefinitionResponse']>[0];
  }) {
    return {
      id: item.id, versionId: item.versionId,
      definition: this.entitlementDefinitionResponse(item.definition),
      booleanValue: item.booleanValue, quota: item.quota?.toString() ?? null,
    };
  }

  private includedCourseResponse(item: {
    id: string; versionId: string; graceDays: number;
    course: { id: string; title: string; slug: string };
  }) {
    return { id: item.id, versionId: item.versionId, graceDays: item.graceDays, course: item.course };
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034');
        if (retryable && attempt < 2) continue;
        if (retryable) {
          throw new ConflictException('Membership plan code or version already exists.');
        }
        throw error;
      }
    }
    throw new Error('Unreachable membership transaction state.');
  }
}
