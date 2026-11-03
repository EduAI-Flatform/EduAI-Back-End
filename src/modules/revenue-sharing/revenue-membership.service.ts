import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, RevenuePlanPolicy } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AcceptRevenueParticipationDto, CreateRevenueTermsDto, RevenuePlanPolicyDto } from './revenue-membership.dto';
import { matchRevenueRule, membershipEffectiveAt, membershipSelections, RevenueMatchingRule, RevenueWeightOverride } from './revenue-membership.rules';

const sourceInclude = { durationOptions: true, serviceEntitlements: true, includedCourses: { include: { course: true } }, plan: true } satisfies Prisma.MembershipPlanVersionInclude;

@Injectable()
export class RevenueMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  listTerms() {
    return this.prisma.revenueTerms.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  }

  createTerms(actorId: string, input: CreateRevenueTermsDto) {
    return this.serializable(async tx => {
      const terms = await tx.revenueTerms.create({ data: { title: input.title.trim(), body: input.body.trim(), createdById: actorId } });
      await this.audit(tx, actorId, 'revenue.terms.created', terms.id, { title: terms.title });
      return terms;
    });
  }

  listPolicies() {
    return this.prisma.revenuePlanPolicy.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  }

  async listSellerCourses(actorId: string, page = 1, pageSize = 25) {
    page = Math.max(1, Math.floor(page));
    pageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const where = { instructorId: actorId, deletedAt: null };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({ where, select: { id: true, title: true }, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.course.count({ where }),
    ]);
    const participations = await this.prisma.revenueParticipation.findMany({ where: { sellerId: actorId, courseId: { in: items.map(item => item.id) } } });
    return { items: items.map(course => {
      const participation = participations.find(item => item.courseId === course.id);
      return { ...course, participationStatus: participation ? participation.leftAt ? 'left' : 'active' : null };
    }), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }

  previewCourse(actorId: string, courseId: string) {
    return this.serializable(async tx => {
      const course = await this.ownedCourse(tx, actorId, courseId);
      const participation = await tx.revenueParticipation.findUnique({ where: { courseId } });
      const terms = await tx.revenueTerms.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
      const policies = await tx.revenuePlanPolicy.findMany({ where: { status: { in: ['active', 'scheduled'] } }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }] });
      const plans = [];
      for (const policy of policies) {
        const rule = matchRevenueRule(course, policy.rules as unknown as RevenueMatchingRule[]);
        const source = await tx.membershipPlanVersion.findUnique({ where: { id: policy.activatedVersionId ?? policy.sourceVersionId }, select: { displayName: true, plan: { select: { status: true } }, includedCourses: { select: { courseId: true, revenueWeight: true } } } });
        if (!source || source.plan.status !== 'active') continue;
        const included = source.includedCourses.find(item => item.courseId === courseId);
        if (!included && !rule) continue;
        let weight: number, totalWeight: number, isIncluded: boolean;
        if (policy.status === 'active' && included) {
          // Current entitlement and share come from the published catalogue, even during notice of removal.
          weight = included.revenueWeight;
          totalWeight = source.includedCourses.reduce((sum, item) => sum + item.revenueWeight, 0);
          isIncluded = true;
        } else {
          const selection = await this.selection(tx, policy);
          weight = rule ? (policy.overrides as unknown as RevenueWeightOverride[]).find(item => item.courseId === courseId)?.weight ?? rule.weight : 0;
          const selected = selection.some(item => item.courseId === courseId);
          totalWeight = selection.reduce((sum, item) => sum + item.weight, 0) + (selected ? 0 : weight);
          isIncluded = policy.status === 'scheduled' && selected;
        }
        plans.push({ planId: policy.planId, displayName: source.displayName, policyId: policy.id, weight, totalWeight,
          shareBps: totalWeight ? Math.floor(weight * 10000 / totalWeight) : 0, platformFeeBps: policy.platformFeeBps,
          effectiveAt: policy.effectiveAt.toISOString(), status: policy.status, isIncluded, isMatching: !!rule });
      }
      return { course: { id: course.id, title: course.title }, participation: participation ? { status: participation.leftAt ? 'left' : 'active', termsId: participation.termsId, acceptedAt: participation.acceptedAt, leftAt: participation.leftAt } : null, terms, plans };
    });
  }

  async accept(actorId: string, courseId: string, input: string | AcceptRevenueParticipationDto) {
    const termsId = typeof input === 'string' ? input : input.termsId;
    await this.serializable(async tx => {
      await this.ownedCourse(tx, actorId, courseId);
      const terms = await tx.revenueTerms.findUnique({ where: { id: termsId } });
      if (!terms) throw new NotFoundException('Revenue terms not found.');
      const currentTerms = await tx.revenueTerms.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (currentTerms?.id !== termsId) throw new ConflictException('Terms changed. Read the current terms before joining.');
      const existing = await tx.revenueParticipation.findUnique({ where: { courseId } });
      if (existing && existing.sellerId !== actorId) throw new ConflictException('Course ownership changed; participation requires administrator review.');
      if (existing && !existing.leftAt) return;
      await tx.revenueParticipation.upsert({ where: { courseId },
        create: { courseId, sellerId: actorId, termsId },
        update: { sellerId: actorId, termsId, acceptedAt: new Date(), leftAt: null } });
      await tx.revenueParticipationEvent.create({ data: { courseId, sellerId: actorId, termsId, action: 'accepted' } });
      await this.audit(tx, actorId, 'revenue.participation.accepted', courseId, { termsId });
      await this.refreshActive(tx, 'participation');
    });
    return this.previewCourse(actorId, courseId);
  }

  async leave(actorId: string, courseId: string) {
    await this.serializable(async tx => {
      await this.ownedCourse(tx, actorId, courseId);
      const current = await tx.revenueParticipation.findUnique({ where: { courseId } });
      if (!current || current.leftAt) return;
      if (current.sellerId !== actorId) throw new NotFoundException('Participation not found.');
      await tx.revenueParticipation.update({ where: { courseId }, data: { leftAt: new Date() } });
      await tx.revenueParticipationEvent.create({ data: { courseId, sellerId: actorId, termsId: current.termsId, action: 'left' } });
      await this.audit(tx, actorId, 'revenue.participation.left', courseId, {});
      // Leaving stops future sales immediately, while historical versions remain untouched.
      await this.refreshActive(tx, 'seller_left', true);
    });
    return this.previewCourse(actorId, courseId);
  }

  previewPolicy(input: RevenuePlanPolicyDto) {
    this.validatePolicy(input);
    return this.serializable(async tx => {
      await this.validateSource(tx, input);
      return this.policyPreview(tx, input);
    });
  }

  schedulePolicy(actorId: string, input: RevenuePlanPolicyDto) {
    this.validatePolicy(input);
    return this.serializable(async tx => {
      const source = await this.validateSource(tx, input);
      const pending = await tx.revenuePlanPolicy.findFirst({ where: { planId: input.planId, status: 'scheduled' } });
      if (pending) throw new ConflictException('Cancel the pending policy before scheduling another change.');
      const policy = await tx.revenuePlanPolicy.create({ data: {
        planId: input.planId, sourceVersionId: source.id, termsId: input.termsId, platformFeeBps: input.platformFeeBps,
        rules: input.rules as unknown as Prisma.InputJsonValue, overrides: input.overrides as unknown as Prisma.InputJsonValue,
        noticeMode: input.noticeMode, noticeDays: input.noticeDays ?? null,
        effectiveAt: membershipEffectiveAt(input.noticeMode, input.noticeDays, new Date()), actorId,
      } });
      await this.notifyPolicy(tx, policy, 'scheduled');
      await this.audit(tx, actorId, 'revenue.membership.policy.scheduled', policy.id, { planId: policy.planId, effectiveAt: policy.effectiveAt.toISOString() });
      if (policy.noticeMode === 'immediate') return this.activate(tx, policy);
      return policy;
    });
  }

  cancelPolicy(actorId: string, policyId: string) {
    return this.serializable(async tx => {
      const policy = await tx.revenuePlanPolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new NotFoundException('Membership revenue policy not found.');
      if (policy.status !== 'scheduled' || policy.effectiveAt <= new Date()) throw new ConflictException('Only a future scheduled change can be cancelled.');
      const result = await tx.revenuePlanPolicy.update({ where: { id: policyId }, data: { status: 'cancelled' } });
      await this.notifyPolicy(tx, policy, 'cancelled');
      await this.audit(tx, actorId, 'revenue.membership.policy.cancelled', policyId, {});
      return result;
    });
  }

  /** Run before checkout takes user/version locks; the caller owns the transaction. */
  async synchronizeCheckout(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);
    const due = await tx.revenuePlanPolicy.findMany({ where: { status: 'scheduled', effectiveAt: { lte: new Date() } }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }] });
    for (const policy of due) await this.activate(tx, policy);
    await this.refreshActive(tx, 'checkout_catalog');
  }
  reconcileDue() {
    return this.serializable(async tx => {
      const due = await tx.revenuePlanPolicy.findMany({ where: { status: 'scheduled', effectiveAt: { lte: new Date() } }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }] });
      for (const policy of due) await this.activate(tx, policy);
      await this.refreshActive(tx, 'catalog');
      return { activated: due.length };
    });
  }

  private validatePolicy(input: RevenuePlanPolicyDto) {
    membershipEffectiveAt(input.noticeMode, input.noticeDays, new Date());
    if (!input.rules.length || input.rules.length > 100 || new Set(input.rules.map(rule => rule.priority)).size !== input.rules.length) throw new BadRequestException('Rule priorities must be unique.');
    if (new Set(input.overrides.map(item => item.courseId)).size !== input.overrides.length) throw new BadRequestException('Course overrides must be unique.');
    for (const rule of input.rules) {
      if (rule.minPriceAmountMinor != null && rule.maxPriceAmountMinor != null && BigInt(rule.minPriceAmountMinor) > BigInt(rule.maxPriceAmountMinor)) throw new BadRequestException('Minimum price must not exceed maximum price.');
    }
  }

  private async validateSource(tx: Prisma.TransactionClient, input: RevenuePlanPolicyDto) {
    const source = await tx.membershipPlanVersion.findUnique({ where: { id: input.sourceVersionId }, include: { plan: true } });
    if (!source || source.planId !== input.planId || source.status !== 'published' || source.plan.status !== 'active') throw new BadRequestException('Select a published version from an active plan.');
    const latest = await tx.membershipPlanVersion.findFirst({ where: { planId: input.planId, status: 'published' }, orderBy: { versionNumber: 'desc' } });
    if (latest?.id !== source.id) throw new ConflictException('Membership version changed. Reload the latest version.');
    if (!await tx.revenueTerms.findUnique({ where: { id: input.termsId } })) throw new NotFoundException('Revenue terms not found.');
    return source;
  }

  private async ownedCourse(tx: Prisma.TransactionClient, actorId: string, courseId: string) {
    const course = await tx.course.findFirst({ where: { id: courseId, instructorId: actorId, deletedAt: null } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private async selection(tx: Prisma.TransactionClient, policy: Pick<RevenuePlanPolicy, 'rules' | 'overrides'>) {
    const participants = await tx.revenueParticipation.findMany({ where: { leftAt: null }, select: { courseId: true, sellerId: true } });
    const courses = await tx.course.findMany({ where: { id: { in: participants.map(item => item.courseId) }, status: 'published', moderationStatus: 'clear', deletedAt: null } });
    const eligible = courses.filter(course => participants.some(item => item.courseId === course.id && item.sellerId === course.instructorId));
    return membershipSelections(eligible, policy.rules as unknown as RevenueMatchingRule[], policy.overrides as unknown as RevenueWeightOverride[]);
  }

  private async policyPreview(tx: Prisma.TransactionClient, input: Pick<RevenuePlanPolicyDto, 'rules' | 'overrides' | 'sourceVersionId'>) {
    const selected = await this.selection(tx, input as unknown as RevenuePlanPolicy);
    const totalWeight = selected.reduce((sum, item) => sum + item.weight, 0);
    const courses = await tx.course.findMany({ where: { id: { in: selected.map(item => item.courseId) } }, select: { id: true, title: true, instructorId: true } });
    const previous = await tx.membershipPlanIncludedCourse.findMany({ where: { versionId: input.sourceVersionId }, include: { course: { select: { title: true, instructorId: true } } } });
    const previousTotalWeight = previous.reduce((sum, item) => sum + item.revenueWeight, 0);
    const previousShare = (weight: number) => previousTotalWeight ? Math.floor(weight * 10000 / previousTotalWeight) : 0;
    return { courses: selected.map(item => {
      const course = courses.find(record => record.id === item.courseId)!;
      const old = previous.find(record => record.courseId === item.courseId);
      return { ...item, title: course.title, sellerId: course.instructorId, shareBps: Math.floor(item.weight * 10000 / totalWeight), previousShareBps: old ? previousShare(old.revenueWeight) : 0 };
    }), removedCourses: previous.filter(item => !selected.some(record => record.courseId === item.courseId)).map(item => ({ courseId: item.courseId, title: item.course.title, sellerId: item.course.instructorId, previousShareBps: previousShare(item.revenueWeight) })),
      totalWeight, previousTotalWeight, affectedSellerCount: new Set([...courses.map(course => course.instructorId), ...previous.map(item => item.course.instructorId)]).size };
  }

  private async refreshActive(tx: Prisma.TransactionClient, reason: string, forceImmediate = false) {
    const policies = await tx.revenuePlanPolicy.findMany({ where: { status: 'active' } });
    for (const current of policies) {
      let source = await tx.membershipPlanVersion.findUnique({ where: { id: current.activatedVersionId ?? current.sourceVersionId }, include: sourceInclude });
      if (!source || source.plan.status !== 'active') continue;
      const participation = await tx.revenueParticipation.findMany({ where: { courseId: { in: source.includedCourses.map(item => item.courseId) }, leftAt: null }, select: { courseId: true, sellerId: true } });
      const retained = source.includedCourses.filter(item => !item.course.deletedAt && item.course.status === 'published' && item.course.moderationStatus === 'clear'
        && participation.some(entry => entry.courseId === item.courseId && entry.sellerId === item.course.instructorId))
        .map(item => ({ courseId: item.courseId, weight: item.revenueWeight })).sort((a, b) => a.courseId.localeCompare(b.courseId));
      // Loss of permission or moderation eligibility cannot wait for a commercial notice period.
      // Keep the original weights and never admit new courses through this immediate path.
      if (retained.length !== source.includedCourses.length) {
        const rebuilt = await this.activate(tx, current, retained);
        current.activatedVersionId = rebuilt.activatedVersionId;
        source = { ...source, id: rebuilt.activatedVersionId!, includedCourses: source.includedCourses.filter(item => retained.some(entry => entry.courseId === item.courseId)) };
      }
      if (forceImmediate) continue;
      const selection = await this.selection(tx, current);
      const old = source.includedCourses.map(item => ({ courseId: item.courseId, weight: item.revenueWeight })).sort((a, b) => a.courseId.localeCompare(b.courseId));
      if (JSON.stringify(old) === JSON.stringify(selection)) continue;
      const pending = await tx.revenuePlanPolicy.findFirst({ where: { planId: current.planId, status: 'scheduled' } });
      if (pending) continue;
      const policy = await tx.revenuePlanPolicy.create({ data: {
        planId: current.planId, sourceVersionId: source.id, termsId: current.termsId, platformFeeBps: current.platformFeeBps,
        rules: current.rules as Prisma.InputJsonValue, overrides: current.overrides as Prisma.InputJsonValue,
        noticeMode: current.noticeMode, noticeDays: current.noticeDays,
        effectiveAt: forceImmediate ? new Date() : membershipEffectiveAt(current.noticeMode, current.noticeDays ?? undefined, new Date()),
        actorId: current.actorId,
      } });
      await this.notifyPolicy(tx, policy, 'scheduled');
      await this.audit(tx, undefined, 'revenue.membership.catalog.changed', policy.id, { reason });
      if (forceImmediate || current.noticeMode === 'immediate') await this.activate(tx, policy);
    }
  }

  private async activate(tx: Prisma.TransactionClient, policy: RevenuePlanPolicy, retained?: Array<{ courseId: string; weight: number }>) {
    const source = await tx.membershipPlanVersion.findUnique({ where: { id: retained ? policy.activatedVersionId ?? policy.sourceVersionId : policy.sourceVersionId }, include: sourceInclude });
    if (!source || source.plan.status !== 'active') {
      return tx.revenuePlanPolicy.update({ where: { id: policy.id }, data: { status: policy.status === 'active' ? 'superseded' : 'cancelled' } });
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM membership_plans WHERE id = ${policy.planId}::uuid FOR UPDATE`);
    const selected = retained ?? await this.selection(tx, policy);
    const versionId = randomUUID();
    await this.notifyPolicy(tx, { ...policy, sourceVersionId: source.id }, 'activated:' + versionId);
    const latest = await tx.membershipPlanVersion.aggregate({ where: { planId: policy.planId }, _max: { versionNumber: true } });
    const now = new Date();
    const created = await tx.membershipPlanVersion.create({ data: {
      id: versionId, planId: source.planId, versionNumber: (latest._max.versionNumber ?? 0) + 1,
      displayName: source.displayName, description: source.description, baseMonthlyPriceAmountMinor: source.baseMonthlyPriceAmountMinor,
      currency: source.currency, salesStartAt: source.salesStartAt, salesEndAt: source.salesEndAt,
      status: 'draft', createdById: policy.actorId,
      revenuePolicyId: policy.id,
      durationOptions: { create: source.durationOptions.map(item => ({ months: item.months, priceAmountMinor: item.priceAmountMinor, discountPercent: item.discountPercent, displayOrder: item.displayOrder })) },
      serviceEntitlements: { create: source.serviceEntitlements.map(item => ({ definitionId: item.definitionId, valueType: item.valueType, resetPeriod: item.resetPeriod, booleanValue: item.booleanValue, quota: item.quota, createdById: policy.actorId })) },
      includedCourses: { create: selected.map(item => ({ courseId: item.courseId, revenueWeight: item.weight, graceDays: source.includedCourses.find(old => old.courseId === item.courseId)?.graceDays ?? 0, createdById: policy.actorId })) },
    } });
    await tx.membershipPlanVersion.update({ where: { id: created.id }, data: { status: 'published', publishedById: policy.actorId, publishedAt: now } });
    if (!retained) await tx.revenuePlanPolicy.updateMany({ where: { planId: policy.planId, status: 'active' }, data: { status: 'superseded' } });
    const activated = await tx.revenuePlanPolicy.update({ where: { id: policy.id }, data: { status: 'active', activatedVersionId: created.id } });
    await this.audit(tx, undefined, 'revenue.membership.policy.activated', policy.id, { versionId: created.id, courseCount: selected.length });
    return activated;
  }

  private async notifyPolicy(tx: Prisma.TransactionClient, policy: RevenuePlanPolicy, event: string) {
    const selected = await this.selection(tx, policy);
    const old = await tx.membershipPlanIncludedCourse.findMany({ where: { versionId: policy.activatedVersionId ?? policy.sourceVersionId }, include: { course: { select: { instructorId: true } } } });
    const matched = await tx.course.findMany({ where: { id: { in: selected.map(item => item.courseId) } }, select: { instructorId: true } });
    const sellers = new Set([...old.map(item => item.course.instructorId), ...matched.map(item => item.instructorId)]);
    for (const userId of sellers) await tx.notification.upsert({
      where: { userId_eventKey: { userId, eventKey: `revenue-policy:${policy.id}:${event}` } }, update: {},
      create: { userId, eventKey: `revenue-policy:${policy.id}:${event}`, type: 'membership_revenue_changed', category: 'system',
        title: event === 'cancelled' ? 'Đã hủy thay đổi gói thành viên' : 'Cập nhật điều khoản chia doanh thu member',
        body: `Gói thành viên có thay đổi (${event}). Phí nền tảng ${policy.platformFeeBps / 100}%. Hiệu lực ${policy.effectiveAt.toISOString()}. Đơn cũ giữ nguyên điều khoản. Bạn có thể ngừng tham gia cho đơn mới.`,
        link: '/instructor/dashboard/revenue-sharing' },
    });
  }

  private audit(tx: Prisma.TransactionClient, actorId: string | undefined, action: string, targetId: string, metadataJson: Prisma.InputJsonValue) {
    return tx.auditLog.create({ data: { actorKind: actorId ? 'USER' : 'SYSTEM', actorId, action, targetType: 'revenue_membership', targetId, metadataJson } });
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          await tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);
          return operation(tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) continue;
        throw error;
      }
    }
    throw new ConflictException('Membership revenue configuration changed. Retry the operation.');
  }
}
