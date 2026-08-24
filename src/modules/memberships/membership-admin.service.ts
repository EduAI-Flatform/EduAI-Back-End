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
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateMembershipPlanDto,
  CreateMembershipPlanVersionDto,
  ListMembershipPlansQueryDto,
  MembershipDurationInputDto,
} from './dto/membership-plan.dto';
import { calculateDurationPrice } from './membership.rules';

const versionInclude = {
  durationOptions: { orderBy: [{ displayOrder: 'asc' as const }, { id: 'asc' as const }] },
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
    };
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
