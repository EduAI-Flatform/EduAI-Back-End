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
import { CommerceProductService } from '../commerce/commerce-product.service';
import {
  ListMembershipPlansQueryDto,
  CreateServiceEntitlementDefinitionDto,
  ListServiceEntitlementDefinitionsQueryDto,
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
type PlanRecord = Prisma.MembershipPlanGetPayload<{ include: typeof planInclude }>;
type VersionRecord = Prisma.MembershipPlanVersionGetPayload<{ include: typeof versionInclude }>;

@Injectable()
export class MembershipAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly commerceProducts: CommerceProductService,
  ) {}

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

  archiveVersion(actorId: string, versionId: string) {
    return this.transitionVersion(actorId, versionId);
  }

  archivePlan(actorId: string, planId: string) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plans WHERE id = ${planId}::uuid FOR UPDATE`);
      const current = await tx.membershipPlan.findUnique({ where: { id: planId } });
      if (!current) throw new NotFoundException('Membership plan not found.');
      if (current.status === MembershipPlanStatus.archived) {
        throw new ConflictException('Membership plan is already archived.');
      }
      await this.commerceProducts.archiveMembershipPlanProducts(tx, actorId, planId);
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
  ) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`);
      const current = await tx.membershipPlanVersion.findUnique({
        where: { id: versionId },
        include: versionInclude,
      });
      if (!current) throw new NotFoundException('Membership plan version not found.');
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM membership_plans WHERE id = ${current.planId}::uuid FOR UPDATE`,
      );
      if (current.status !== MembershipPlanVersionStatus.published) {
        throw new ConflictException('Membership version cannot archive from its current state.');
      }
      const now = new Date();
      const updated = await tx.membershipPlanVersion.update({
        where: { id: versionId },
        data: {
          status: MembershipPlanVersionStatus.archived,
          archivedById: actorId,
          archivedAt: now,
        },
        include: versionInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.MembershipPlanVersionArchived,
          target: { type: 'membership_plan_version', id: versionId },
          metadata: { planId: current.planId, versionNumber: current.versionNumber },
        },
        tx,
      );
      return this.versionResponse(updated);
    });
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
