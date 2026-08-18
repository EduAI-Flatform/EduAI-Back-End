import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  VoucherKind,
  VoucherStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { ListVouchersQueryDto } from './dto/list-vouchers-query.dto';
import {
  evaluateVoucherEligibility,
  type VoucherDecision,
  type VoucherEligibilityContext,
  type VoucherPolicy,
} from './voucher.rules';

const voucherAdminSelect = {
  id: true,
  code: true,
  status: true,
  kind: true,
  value: true,
  currency: true,
  startsAt: true,
  endsAt: true,
  minimumCoursePriceMinor: true,
  maximumDiscountMinor: true,
  usageLimit: true,
  redeemedCount: true,
  perUserLimit: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  courseScopes: { select: { courseId: true } },
  categoryScopes: { select: { categorySlug: true } },
  eligibleUsers: { select: { userId: true } },
} satisfies Prisma.VoucherSelect;

const voucherRuntimeSelect = {
  id: true,
  code: true,
  status: true,
  kind: true,
  value: true,
  currency: true,
  startsAt: true,
  endsAt: true,
  minimumCoursePriceMinor: true,
  maximumDiscountMinor: true,
  usageLimit: true,
  redeemedCount: true,
  perUserLimit: true,
  courseScopes: { select: { courseId: true } },
  categoryScopes: { select: { categorySlug: true } },
  eligibleUsers: { select: { userId: true } },
} satisfies Prisma.VoucherSelect;

type VoucherAdminRecord = Prisma.VoucherGetPayload<{
  select: typeof voucherAdminSelect;
}>;
type VoucherRuntimeRecord = Prisma.VoucherGetPayload<{
  select: typeof voucherRuntimeSelect;
}>;

export interface VoucherResponse {
  id: string;
  code: string;
  status: VoucherStatus;
  kind: VoucherKind;
  value: number;
  currency: string;
  startsAt: Date;
  endsAt: Date;
  minimumCoursePriceMinor: number | null;
  maximumDiscountMinor: number | null;
  usageLimit: number | null;
  redeemedCount: number;
  perUserLimit: number | null;
  courseIds: string[];
  categorySlugs: string[];
  eligibleUserIds: string[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoucherPreviewResponse extends VoucherDecision {
  voucherId: string;
  code: string;
  currency: string;
}

export interface VoucherRedemptionResponse {
  id: string;
  voucherId: string;
  userId: string;
  courseId: string;
  redemptionKey: string;
  originalAmountMinor: number;
  discountAmountMinor: number;
  finalAmountMinor: number;
  currency: string;
  createdAt: Date;
  idempotent: boolean;
}

export interface VoucherPage {
  items: VoucherResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface VoucherRedemptionPage {
  items: VoucherRedemptionResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createVoucher(
    actorId: string,
    input: CreateVoucherDto,
  ): Promise<VoucherResponse> {
    const normalized = this.normalizeCreateInput(input);
    this.assertPolicy(normalized);
    await this.assertScopeTargets(normalized.courseIds, normalized.eligibleUserIds);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.voucher.create({
          data: {
            code: normalized.code,
            status: VoucherStatus.draft,
            kind: normalized.kind,
            value: normalized.value,
            currency: normalized.currency,
            startsAt: new Date(normalized.startsAt),
            endsAt: new Date(normalized.endsAt),
            minimumCoursePriceMinor: normalized.minimumCoursePriceMinor,
            maximumDiscountMinor: normalized.maximumDiscountMinor,
            usageLimit: normalized.usageLimit,
            perUserLimit: normalized.perUserLimit,
            createdById: actorId,
            courseScopes: {
              create: normalized.courseIds.map((courseId) => ({ courseId })),
            },
            categoryScopes: {
              create: normalized.categorySlugs.map((categorySlug) => ({ categorySlug })),
            },
            eligibleUsers: {
              create: normalized.eligibleUserIds.map((userId) => ({ userId })),
            },
          },
          select: voucherAdminSelect,
        });
        await this.auditService.record(
          {
            actorId,
            action: AuditAction.VoucherCreated,
            target: { type: 'voucher', id: created.id },
            metadata: { code: created.code, status: created.status },
          },
          tx,
        );
        return this.toVoucherResponse(created);
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) {
        throw new ConflictException('Voucher code is already in use');
      }
      throw error;
    }
  }

  async getVoucher(id: string): Promise<VoucherResponse> {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id },
      select: voucherAdminSelect,
    });
    if (!voucher) throw new NotFoundException('Voucher not found');
    return this.toVoucherResponse(voucher);
  }

  async listVouchers(query: ListVouchersQueryDto): Promise<VoucherPage> {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.voucher.count(),
      this.prisma.voucher.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: voucherAdminSelect,
      }),
    ]);
    return {
      items: items.map((item) => this.toVoucherResponse(item)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async listRedemptions(
    voucherId: string,
    query: ListVouchersQueryDto,
  ): Promise<VoucherRedemptionPage> {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: voucherId },
      select: { id: true },
    });
    if (!voucher) throw new NotFoundException('Voucher not found');
    const [total, items] = await this.prisma.$transaction([
      this.prisma.voucherRedemption.count({ where: { voucherId } }),
      this.prisma.voucherRedemption.findMany({
        where: { voucherId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: items.map((item) => this.toRedemptionResponse(item, false)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async updateVoucher(
    actorId: string,
    id: string,
    input: UpdateVoucherDto,
  ): Promise<VoucherResponse> {
    const current = await this.prisma.voucher.findUnique({
      where: { id },
      select: {
        ...voucherAdminSelect,
        redeemedCount: true,
      },
    });
    if (!current) throw new NotFoundException('Voucher not found');

    const normalized = this.normalizeUpdateInput(current, input);
    this.assertPolicy(normalized);
    if (
      current.redeemedCount > 0 &&
      this.changesEconomicPolicy(current, input)
    ) {
      throw new ConflictException(
        'Economic voucher policy cannot change after redemption; disable it instead',
      );
    }
    await this.assertScopeTargets(normalized.courseIds, normalized.eligibleUserIds);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.voucher.update({
          where: { id },
          data: {
            code: normalized.code,
            status: normalized.status,
            kind: normalized.kind,
            value: normalized.value,
            currency: normalized.currency,
            startsAt: new Date(normalized.startsAt),
            endsAt: new Date(normalized.endsAt),
            minimumCoursePriceMinor: normalized.minimumCoursePriceMinor,
            maximumDiscountMinor: normalized.maximumDiscountMinor,
            usageLimit: normalized.usageLimit,
            perUserLimit: normalized.perUserLimit,
            courseScopes: {
              deleteMany: {},
              create: normalized.courseIds.map((courseId) => ({ courseId })),
            },
            categoryScopes: {
              deleteMany: {},
              create: normalized.categorySlugs.map((categorySlug) => ({ categorySlug })),
            },
            eligibleUsers: {
              deleteMany: {},
              create: normalized.eligibleUserIds.map((userId) => ({ userId })),
            },
          },
          select: voucherAdminSelect,
        });
        await this.auditService.record(
          {
            actorId,
            action: AuditAction.VoucherUpdated,
            target: { type: 'voucher', id },
            metadata: { code: updated.code, status: updated.status },
          },
          tx,
        );
        return this.toVoucherResponse(updated);
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) {
        throw new ConflictException('Voucher code is already in use');
      }
      throw error;
    }
  }

  async preview(
    userId: string,
    courseId: string,
    code: string,
  ): Promise<VoucherPreviewResponse> {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: this.normalizeCode(code) },
      select: voucherRuntimeSelect,
    });
    if (!voucher) this.throwDecision('code_invalid');
    const course = await this.findPurchasableCourse(this.prisma, courseId);
    const userRedemptionCount = await this.prisma.voucherRedemption.count({
      where: { voucherId: voucher.id, userId },
    });
    return this.toPreviewResponse(
      voucher,
      this.evaluate(voucher, course, userId, code, userRedemptionCount),
    );
  }

  async redeem(
    userId: string,
    courseId: string,
    input: RedeemVoucherDto,
  ): Promise<VoucherRedemptionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const voucherId = await this.findVoucherId(tx, input.code);
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "vouchers" WHERE id = ${voucherId} FOR UPDATE
      `;
      const voucher = await tx.voucher.findUnique({
        where: { id: voucherId },
        select: voucherRuntimeSelect,
      });
      if (!voucher) this.throwDecision('code_invalid');

      const existing = await tx.voucherRedemption.findUnique({
        where: {
          voucherId_userId_redemptionKey: {
            voucherId,
            userId,
            redemptionKey: input.redemptionKey,
          },
        },
      });
      if (existing) {
        if (existing.courseId !== courseId) {
          throw new ConflictException('Redemption key was already used for another course');
        }
        return this.toRedemptionResponse(existing, true);
      }

      const course = await this.findPurchasableCourse(tx, courseId);
      const userRedemptionCount = await tx.voucherRedemption.count({
        where: { voucherId, userId },
      });
      const decision = this.evaluate(
        voucher,
        course,
        userId,
        input.code,
        userRedemptionCount,
      );
      if (!decision.eligible) this.throwDecision(decision.reason);

      const redemption = await tx.voucherRedemption.create({
        data: {
          voucherId,
          userId,
          courseId,
          redemptionKey: input.redemptionKey,
          originalAmountMinor: course.priceAmountMinor as number,
          discountAmountMinor: decision.discountAmountMinor,
          finalAmountMinor: decision.finalAmountMinor,
          currency: course.priceCurrency as string,
        },
      });
      await tx.voucher.update({
        where: { id: voucherId },
        data: { redeemedCount: { increment: 1 } },
      });
      await this.auditService.record(
        {
          actorId: userId,
          action: AuditAction.VoucherRedeemed,
          target: { type: 'voucher_redemption', id: redemption.id },
          metadata: {
            voucherId,
            courseId,
            originalAmountMinor: redemption.originalAmountMinor,
            discountAmountMinor: redemption.discountAmountMinor,
            finalAmountMinor: redemption.finalAmountMinor,
            currency: redemption.currency,
            redemptionKey: input.redemptionKey,
          },
        },
        tx,
      );
      return this.toRedemptionResponse(redemption, false);
    });
  }

  private async findVoucherId(
    client: Prisma.TransactionClient,
    code: string,
  ): Promise<string> {
    const voucher = await client.voucher.findUnique({
      where: { code: this.normalizeCode(code) },
      select: { id: true },
    });
    if (!voucher) this.throwDecision('code_invalid');
    return voucher.id;
  }

  private async findPurchasableCourse(
    client: PrismaService | Prisma.TransactionClient,
    courseId: string,
  ) {
    const course = await client.course.findFirst({
      where: {
        id: courseId,
        status: 'published',
        visibility: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        categorySlug: true,
        priceAmountMinor: true,
        priceCurrency: true,
      },
    });
    if (!course) throw new NotFoundException('Published course not found');
    return course;
  }

  private evaluate(
    voucher: VoucherRuntimeRecord,
    course: Awaited<ReturnType<VouchersService['findPurchasableCourse']>>,
    userId: string,
    code: string,
    userRedemptionCount: number,
  ): VoucherDecision {
    const policy: VoucherPolicy = {
      code: voucher.code,
      status: voucher.status,
      kind: voucher.kind,
      value: voucher.value,
      currency: voucher.currency,
      startsAt: voucher.startsAt.toISOString(),
      endsAt: voucher.endsAt.toISOString(),
      minimumCoursePriceMinor: voucher.minimumCoursePriceMinor,
      maximumDiscountMinor: voucher.maximumDiscountMinor,
      usageLimit: voucher.usageLimit,
      redeemedCount: voucher.redeemedCount,
      perUserLimit: voucher.perUserLimit,
      userRedemptionCount,
      courseIds: voucher.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: voucher.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: voucher.eligibleUsers.map(({ userId: id }) => id),
    };
    const context: VoucherEligibilityContext = {
      now: new Date().toISOString(),
      submittedCode: code,
      userId,
      courseId: course.id,
      categorySlug: course.categorySlug,
      coursePrice: {
        amountMinor: course.priceAmountMinor ?? -1,
        currency: course.priceCurrency ?? '',
      },
    };
    return evaluateVoucherEligibility(policy, context);
  }

  private toPreviewResponse(
    voucher: VoucherRuntimeRecord,
    decision: VoucherDecision,
  ): VoucherPreviewResponse {
    return {
      voucherId: voucher.id,
      code: voucher.code,
      currency: voucher.currency,
      ...decision,
    };
  }

  private toVoucherResponse(record: VoucherAdminRecord): VoucherResponse {
    return {
      id: record.id,
      code: record.code,
      status: record.status,
      kind: record.kind,
      value: record.value,
      currency: record.currency,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      minimumCoursePriceMinor: record.minimumCoursePriceMinor,
      maximumDiscountMinor: record.maximumDiscountMinor,
      usageLimit: record.usageLimit,
      redeemedCount: record.redeemedCount,
      perUserLimit: record.perUserLimit,
      courseIds: record.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: record.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: record.eligibleUsers.map(({ userId }) => userId),
      createdById: record.createdById,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toRedemptionResponse(
    redemption: {
      id: string;
      voucherId: string;
      userId: string;
      courseId: string;
      redemptionKey: string;
      originalAmountMinor: number;
      discountAmountMinor: number;
      finalAmountMinor: number;
      currency: string;
      createdAt: Date;
    },
    idempotent: boolean,
  ): VoucherRedemptionResponse {
    return { ...redemption, idempotent };
  }

  private normalizeCreateInput(input: CreateVoucherDto) {
    return {
      code: this.normalizeCode(input.code),
      kind: input.kind,
      value: input.value,
      currency: input.currency.toUpperCase(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      minimumCoursePriceMinor: input.minimumCoursePriceMinor ?? null,
      maximumDiscountMinor: input.maximumDiscountMinor ?? null,
      usageLimit: input.usageLimit ?? null,
      perUserLimit: input.perUserLimit ?? null,
      courseIds: [...new Set(input.courseIds ?? [])],
      categorySlugs: [...new Set((input.categorySlugs ?? []).map((value) => value.toLowerCase()))],
      eligibleUserIds: [...new Set(input.eligibleUserIds ?? [])],
      status: VoucherStatus.draft,
    };
  }

  private normalizeUpdateInput(current: VoucherAdminRecord, input: UpdateVoucherDto) {
    return {
      code: input.code === undefined ? current.code : this.normalizeCode(input.code),
      kind: input.kind ?? current.kind,
      value: input.value ?? current.value,
      currency: input.currency?.toUpperCase() ?? current.currency,
      startsAt: input.startsAt ?? current.startsAt.toISOString(),
      endsAt: input.endsAt ?? current.endsAt.toISOString(),
      minimumCoursePriceMinor: input.minimumCoursePriceMinor ?? current.minimumCoursePriceMinor,
      maximumDiscountMinor: input.maximumDiscountMinor ?? current.maximumDiscountMinor,
      usageLimit: input.usageLimit ?? current.usageLimit,
      perUserLimit: input.perUserLimit ?? current.perUserLimit,
      courseIds: input.courseIds ?? current.courseScopes.map(({ courseId }) => courseId),
      categorySlugs: input.categorySlugs ?? current.categoryScopes.map(({ categorySlug }) => categorySlug),
      eligibleUserIds: input.eligibleUserIds ?? current.eligibleUsers.map(({ userId }) => userId),
      status: input.status ?? current.status,
    };
  }

  private assertPolicy(input: {
    kind: VoucherKind;
    value: number;
    currency: string;
    startsAt: string;
    endsAt: string;
    minimumCoursePriceMinor: number | null;
    maximumDiscountMinor: number | null;
    usageLimit: number | null;
    perUserLimit: number | null;
  }): void {
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new BadRequestException('Voucher currency must be ISO 4217');
    }
    if (!Number.isFinite(Date.parse(input.startsAt)) || !Number.isFinite(Date.parse(input.endsAt))) {
      throw new BadRequestException('Voucher dates must be valid');
    }
    if (Date.parse(input.startsAt) > Date.parse(input.endsAt)) {
      throw new BadRequestException('Voucher start must be before its end');
    }
    if (
      (input.kind === VoucherKind.percentage && (input.value < 1 || input.value > 100)) ||
      (input.kind === VoucherKind.fixed && input.value < 1)
    ) {
      throw new BadRequestException('Voucher value is invalid for its kind');
    }
  }

  private async assertScopeTargets(courseIds: string[], userIds: string[]): Promise<void> {
    const [courses, users] = await Promise.all([
      this.prisma.course.count({ where: { id: { in: courseIds } } }),
      this.prisma.user.count({ where: { id: { in: userIds }, deletedAt: null } }),
    ]);
    if (courses !== courseIds.length) throw new BadRequestException('Voucher course scope contains an unknown course');
    if (users !== userIds.length) throw new BadRequestException('Voucher user eligibility contains an unknown user');
  }

  private changesEconomicPolicy(current: VoucherAdminRecord, input: UpdateVoucherDto): boolean {
    return [
      'code', 'kind', 'value', 'currency', 'startsAt', 'endsAt',
      'minimumCoursePriceMinor', 'maximumDiscountMinor', 'usageLimit', 'perUserLimit',
    ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
  }

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private throwDecision(reason: string): never {
    throw new BadRequestException({ error: reason, message: 'Voucher is not eligible' });
  }

  private isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
