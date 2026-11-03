import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RevenueMembershipService } from './revenue-membership.service';
import { RevenuePlanPolicyDto } from './revenue-membership.dto';
import { PrismaService } from '../../prisma/prisma.service';

const source = {
  id: 'version-1', planId: 'plan-1', versionNumber: 1, status: 'published', plan: { status: 'active' },
  displayName: 'Gold', description: null, baseMonthlyPriceAmountMinor: 300000n, currency: 'VND', salesStartAt: null, salesEndAt: null,
  durationOptions: [{ months: 12, priceAmountMinor: 3000000n, discountPercent: null, displayOrder: 0 }],
  serviceEntitlements: [{ definitionId: 'definition-1', valueType: 'metered', resetPeriod: 'calendar_month', booleanValue: null, quota: 10n }],
  includedCourses: [{ courseId: 'old-course', revenueWeight: 1, graceDays: 7, course: { instructorId: 'old-seller', title: 'Previous course' } }],
};
const course = { id: 'course-1', instructorId: 'seller-1', title: 'Coding', categorySlug: 'coding', level: 'beginner', priceAmountMinor: 200000, status: 'published', moderationStatus: 'clear', deletedAt: null };
const input: RevenuePlanPolicyDto = { planId: 'plan-1', sourceVersionId: source.id, termsId: 'terms-1', platformFeeBps: 4000, noticeMode: 'immediate', rules: [{ priority: 1, weight: 2 }], overrides: [] };

function harness() {
  const sequence: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    course: { findFirst: jest.fn().mockResolvedValue(course), findMany: jest.fn().mockResolvedValue([course]) },
    revenueTerms: { findUnique: jest.fn().mockResolvedValue({ id: 'terms-1' }), findFirst: jest.fn().mockResolvedValue({ id: 'terms-1' }), findMany: jest.fn().mockResolvedValue([{ id: 'terms-1' }]) },
    revenueParticipation: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([{ courseId: course.id, sellerId: course.instructorId }]), upsert: jest.fn(), update: jest.fn() },
    revenueParticipationEvent: { create: jest.fn() },
    revenuePlanPolicy: {
      findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => ({ ...data, id: 'policy-1', status: 'scheduled', createdAt: new Date(), activatedVersionId: null })),
      updateMany: jest.fn(), update: jest.fn().mockImplementation(({ data }) => ({ ...data, id: 'policy-1' })),
    },
    membershipPlanVersion: {
      update: jest.fn().mockImplementation(({ data, where }) => ({ ...data, id: where.id })), findUnique: jest.fn().mockResolvedValue(source), findFirst: jest.fn().mockResolvedValue(source), aggregate: jest.fn().mockResolvedValue({ _max: { versionNumber: 1 } }),
      create: jest.fn().mockImplementation(({ data }) => { sequence.push('version'); return data; }),
    },
    membershipPlanIncludedCourse: { findMany: jest.fn().mockResolvedValue(source.includedCourses) },
    notification: { upsert: jest.fn().mockImplementation(() => { sequence.push('notification'); return {}; }) },
    auditLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)) };
  return { service: new RevenueMembershipService(prisma as unknown as PrismaService), tx, sequence };
}

describe('membership revenue lifecycle', () => {
  it('creates a new published snapshot and notifies before publication without changing the source', async () => {
    const { service, tx, sequence } = harness();
    const before = JSON.stringify(source, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    await service.schedulePolicy('admin-1', input);
    const created = tx.membershipPlanVersion.create.mock.calls[0][0].data;
    expect(created.id).not.toBe(source.id);
    expect(created.versionNumber).toBe(2);
    expect(created.revenuePolicyId).toBe('policy-1');
    expect(created.status).toBe('draft');
    expect(tx.membershipPlanVersion.update).toHaveBeenCalledWith({ where: { id: created.id }, data: expect.objectContaining({ status: 'published' }) });
    expect(created.includedCourses.create).toEqual([{ courseId: 'course-1', revenueWeight: 2, graceDays: 0, createdById: 'admin-1' }]);
    expect(created.durationOptions.create[0].months).toBe(12);
    expect(created.serviceEntitlements.create[0].quota).toBe(10n);
    expect(sequence.indexOf('notification')).toBeLessThan(sequence.indexOf('version'));
    expect(JSON.stringify(source, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value)).toBe(before);
  });

  it('announces delayed policy without creating a version before its effective date', async () => {
    const { service, tx } = harness();
    const result = await service.schedulePolicy('admin-1', { ...input, noticeMode: 'delayed', noticeDays: 4 });
    expect(result.status).toBe('scheduled');
    expect(tx.membershipPlanVersion.create).not.toHaveBeenCalled();
    expect(tx.notification.upsert).toHaveBeenCalled();
  });

  it('rejects a stale source version instead of silently changing membership benefits', async () => {
    const { service, tx } = harness();
    tx.membershipPlanVersion.findFirst.mockResolvedValue({ ...source, id: 'new-version' });
    await expect(service.schedulePolicy('admin-1', input)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.revenuePlanPolicy.create).not.toHaveBeenCalled();
  });

  it('does not allow ownership bypass when accepting another sellers course', async () => {
    const { service, tx } = harness();
    tx.course.findFirst.mockResolvedValue(null);
    await expect(service.accept('attacker', 'course-1', 'terms-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.revenueParticipation.upsert).not.toHaveBeenCalled();
  });

  it('stores append-only acceptance evidence and prevents duplicate active acceptance', async () => {
    const { service, tx } = harness();
    await service.accept('seller-1', 'course-1', 'terms-1');
    expect(tx.revenueParticipationEvent.create).toHaveBeenCalledWith({ data: { courseId: 'course-1', sellerId: 'seller-1', termsId: 'terms-1', action: 'accepted' } });
    tx.revenueParticipation.findUnique.mockResolvedValue({ courseId: 'course-1', sellerId: 'seller-1', termsId: 'terms-1', leftAt: null });
    await service.accept('seller-1', 'course-1', 'terms-1');
    expect(tx.revenueParticipationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('rejects stale terms before storing acceptance', async () => {
    const { service, tx } = harness();
    tx.revenueTerms.findFirst.mockResolvedValue({ id: 'terms-2' });
    await expect(service.accept('seller-1', 'course-1', 'terms-1')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.revenueParticipationEvent.create).not.toHaveBeenCalled();
  });

  it('allows cancellation only for changes not activated yet', async () => {
    const { service, tx } = harness();
    tx.revenuePlanPolicy.findUnique = jest.fn().mockResolvedValue({ id: 'policy-1', status: 'active' });
    await expect(service.cancelPolicy('admin-1', 'policy-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes a leaving seller immediately without overwriting a scheduled commercial change', async () => {
    const { service, tx } = harness();
    const active = { ...input, id: 'active-policy', status: 'active', actorId: 'admin-1', activatedVersionId: 'version-1', noticeMode: 'delayed', noticeDays: 7, effectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') };
    tx.revenueParticipation.findUnique.mockResolvedValue({ courseId: 'course-1', sellerId: 'seller-1', termsId: 'terms-1', leftAt: null });
    tx.revenueParticipation.findMany.mockResolvedValue([]);
    tx.revenuePlanPolicy.findMany.mockResolvedValueOnce([active]).mockResolvedValue([]);
    tx.revenuePlanPolicy.findFirst.mockResolvedValue({ id: 'scheduled-policy', status: 'scheduled' });
    await service.leave('seller-1', 'course-1');
    expect(tx.revenueParticipationEvent.create).toHaveBeenCalledWith({ data: { courseId: 'course-1', sellerId: 'seller-1', termsId: 'terms-1', action: 'left' } });
    expect(tx.revenuePlanPolicy.create).not.toHaveBeenCalled();
    expect(tx.revenuePlanPolicy.updateMany).not.toHaveBeenCalled();
    expect(tx.membershipPlanVersion.create.mock.calls[0][0].data.revenuePolicyId).toBe('active-policy');
    expect(tx.revenuePlanPolicy.update.mock.calls[0][0].where.id).toBe('active-policy');
  });
  it('previews before and after shares and explicitly discloses removed courses', async () => {
    const { service, tx } = harness();
    tx.membershipPlanIncludedCourse.findMany.mockResolvedValue([
      { courseId: 'course-1', revenueWeight: 3, graceDays: 0, course: { instructorId: 'seller-1', title: 'Coding' } },
      { courseId: 'removed-course', revenueWeight: 1, graceDays: 0, course: { instructorId: 'seller-2', title: 'Removed course' } },
    ]);
    const preview = await service.previewPolicy(input);
    expect(preview.previousTotalWeight).toBe(4);
    expect(preview.totalWeight).toBe(2);
    expect(preview.courses).toEqual([{ courseId: 'course-1', title: 'Coding', sellerId: 'seller-1', weight: 2, shareBps: 10000, previousShareBps: 7500 }]);
    expect(preview.removedCourses).toEqual([{ courseId: 'removed-course', title: 'Removed course', sellerId: 'seller-2', previousShareBps: 2500 }]);
    expect(preview.affectedSellerCount).toBe(2);
  });
  it.each([
    { label: 'ownership no longer matches accepted participation', patch: { instructorId: 'new-nonconsenting-owner' } },
    { label: 'moderation hides a course', patch: { moderationStatus: 'hidden' } },
    { label: 'publication is withdrawn', patch: { status: 'archived' } },
    { label: 'course is deleted', patch: { deletedAt: new Date('2026-11-03') } },
  ])('strips hard-ineligible courses immediately under delayed notice: $label', async ({ patch }) => {
    const { service, tx } = harness();
    const invalid = { ...course, ...patch };
    const valid = { ...course, id: 'valid-course' };
    const newCandidate = { ...course, id: 'new-course' };
    const active = { ...input, id: 'active-policy', status: 'active', actorId: 'admin-1', activatedVersionId: 'version-1', noticeMode: 'delayed', noticeDays: 7, effectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') };
    tx.membershipPlanVersion.findUnique.mockResolvedValue({ ...source, includedCourses: [
      { courseId: invalid.id, revenueWeight: 3, graceDays: 0, course: invalid },
      { courseId: valid.id, revenueWeight: 9, graceDays: 0, course: valid },
    ] });
    tx.revenueParticipation.findMany.mockResolvedValue([
      { courseId: invalid.id, sellerId: 'seller-1' }, { courseId: valid.id, sellerId: 'seller-1' }, { courseId: newCandidate.id, sellerId: 'seller-1' },
    ]);
    tx.course.findMany.mockResolvedValue([invalid, valid, newCandidate]);
    tx.revenuePlanPolicy.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([active]);
    tx.revenuePlanPolicy.findFirst.mockResolvedValue({ id: 'pending-policy', status: 'scheduled' });
    await service.reconcileDue();
    const created = tx.membershipPlanVersion.create.mock.calls[0][0].data;
    expect(created.includedCourses.create).toEqual([{ courseId: 'valid-course', revenueWeight: 9, graceDays: 0, createdById: 'admin-1' }]);
    expect(created.revenuePolicyId).toBe('active-policy');
    expect(tx.revenuePlanPolicy.create).not.toHaveBeenCalled();
    expect(tx.revenuePlanPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('keeps commercial category changes under notice rather than treating them as hard removals', async () => {
    const { service, tx } = harness();
    const live = { ...course, categorySlug: 'other-category' };
    const active = { ...input, id: 'active-policy', status: 'active', actorId: 'admin-1', activatedVersionId: 'version-1', rules: [{ priority: 1, categorySlugs: ['coding'], weight: 2 }], noticeMode: 'delayed', noticeDays: 7, effectiveAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') };
    tx.membershipPlanVersion.findUnique.mockResolvedValue({ ...source, includedCourses: [{ courseId: course.id, revenueWeight: 3, graceDays: 0, course: live }] });
    tx.course.findMany.mockResolvedValue([live]);
    tx.revenuePlanPolicy.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([active]);
    await service.reconcileDue();
    expect(tx.membershipPlanVersion.create).not.toHaveBeenCalled();
    const scheduled = tx.revenuePlanPolicy.create.mock.calls[0][0].data;
    expect(scheduled.noticeMode).toBe('delayed');
    expect(scheduled.noticeDays).toBe(7);
    expect(scheduled.effectiveAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
  });
  it('keeps the actual active catalogue share visible when commercial matching changes during notice', async () => {
    const { service, tx } = harness();
    const policy = { ...input, id: 'policy-1', status: 'active', actorId: 'admin-1', activatedVersionId: 'version-1', rules: [{ priority: 1, categorySlugs: ['coding'], weight: 2 }], effectiveAt: new Date('2026-01-01') };
    tx.course.findFirst.mockResolvedValue({ ...course, categorySlug: 'changed-category' });
    tx.revenuePlanPolicy.findMany.mockResolvedValue([policy]);
    tx.membershipPlanVersion.findUnique.mockResolvedValue({ ...source, includedCourses: [
      { courseId: course.id, revenueWeight: 3 }, { courseId: 'another-course', revenueWeight: 1 },
    ] });
    const preview = await service.previewCourse('seller-1', course.id);
    expect(preview.plans).toEqual([expect.objectContaining({ status: 'active', weight: 3, totalWeight: 4, shareBps: 7500, isIncluded: true, isMatching: false })]);
  });

  it('marks a matching course awaiting delayed admission as hypothetical instead of already included', async () => {
    const { service, tx } = harness();
    const policy = { ...input, id: 'policy-1', status: 'active', actorId: 'admin-1', activatedVersionId: 'version-1', effectiveAt: new Date('2026-01-01') };
    tx.revenuePlanPolicy.findMany.mockResolvedValue([policy]);
    const preview = await service.previewCourse('seller-1', course.id);
    expect(preview.plans).toEqual([expect.objectContaining({ status: 'active', weight: 2, isIncluded: false, isMatching: true })]);
  });

  it('shows an explicit zero share for a scheduled removal rather than hiding the plan', async () => {
    const { service, tx } = harness();
    const policy = { ...input, id: 'policy-1', status: 'scheduled', actorId: 'admin-1', activatedVersionId: null, rules: [{ priority: 1, categorySlugs: ['different-category'], weight: 2 }], effectiveAt: new Date('2030-01-01') };
    tx.revenuePlanPolicy.findMany.mockResolvedValue([policy]);
    tx.membershipPlanVersion.findUnique.mockResolvedValue({ ...source, includedCourses: [{ courseId: course.id, revenueWeight: 3 }] });
    const preview = await service.previewCourse('seller-1', course.id);
    expect(preview.plans).toEqual([expect.objectContaining({ status: 'scheduled', weight: 0, shareBps: 0, isIncluded: false, isMatching: false })]);
  });
  it('accepts optional null price bounds without converting null to BigInt', async () => {
    const { service } = harness();
    const preview = await service.previewPolicy({ ...input, rules: [{ priority: 1, weight: 2, minPriceAmountMinor: null as unknown as string, maxPriceAmountMinor: null as unknown as string }] });
    expect(preview.totalWeight).toBe(2);
  });
  it('rejects ambiguous priorities and inverted price intervals', () => {
    const { service } = harness();
    expect(() => service.previewPolicy({ ...input, rules: [{ priority: 0, weight: 1 }, { priority: 0, weight: 3 }] })).toThrow(BadRequestException);
    expect(() => service.previewPolicy({ ...input, rules: [{ priority: 0, weight: 1, minPriceAmountMinor: '100', maxPriceAmountMinor: '99' }] })).toThrow(BadRequestException);
  });
});
