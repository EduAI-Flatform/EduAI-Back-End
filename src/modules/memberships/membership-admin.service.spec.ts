import { ConflictException, NotFoundException } from '@nestjs/common';
import { MembershipPlanVersionStatus } from '../../../generated/prisma/client';
import { MembershipAdminService } from './membership-admin.service';

const version = {
  id: 'version-id',
  planId: 'plan-id',
  versionNumber: 1,
  displayName: 'Gold',
  description: null,
  baseMonthlyPriceAmountMinor: 100_000n,
  currency: 'VND',
  salesStartAt: null,
  salesEndAt: null,
  status: MembershipPlanVersionStatus.draft,
  createdById: 'admin-id',
  publishedById: null,
  archivedById: null,
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:00:00.000Z'),
  publishedAt: null,
  archivedAt: null,
  durationOptions: [
    {
      id: 'duration-id',
      versionId: 'version-id',
      months: 3,
      priceAmountMinor: null,
      discountPercent: 25,
      displayOrder: 0,
      createdAt: new Date('2026-08-24T00:00:00.000Z'),
    },
  ],
  serviceEntitlements: [],
  includedCourses: [],
};

function harness() {
  const tx = {
    $queryRaw: jest.fn(),
    membershipPlan: {
      create: jest.fn().mockResolvedValue({
        id: 'plan-id',
        code: 'GOLD',
        status: 'active',
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
        archivedAt: null,
        versions: [version],
      }),
      findUnique: jest.fn().mockResolvedValue({ id: 'plan-id', status: 'active' }),
      update: jest.fn(),
    },
    membershipPlanVersion: {
      aggregate: jest.fn().mockResolvedValue({ _max: { versionNumber: 1 } }),
      create: jest.fn().mockResolvedValue({ ...version, versionNumber: 2 }),
      findUnique: jest.fn().mockResolvedValue(version),
      update: jest.fn().mockResolvedValue({
        ...version,
        status: MembershipPlanVersionStatus.published,
        publishedById: 'admin-id',
        publishedAt: new Date('2026-08-24T01:00:00.000Z'),
      }),
    },
    serviceEntitlementDefinition: {
      create: jest.fn().mockResolvedValue({
        id: 'definition-id', code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month',
        displayName: 'AI chat', description: null, unitLabel: 'request', displayOrder: 1,
      }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'definition-id', code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month',
        displayName: 'AI chat', description: null, unitLabel: 'request', displayOrder: 1,
      }),
    },
    membershipPlanEntitlement: {
      create: jest.fn().mockResolvedValue({
        id: 'plan-entitlement-id', versionId: 'version-id', booleanValue: null, quota: 30n,
        definition: {
          id: 'definition-id', code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month',
          displayName: 'AI chat', description: null, unitLabel: 'request', displayOrder: 1,
        },
      }),
    },
    course: {
      findFirst: jest.fn().mockResolvedValue({ id: 'course-id', title: 'Course', slug: 'course' }),
    },
    membershipPlanIncludedCourse: {
      create: jest.fn().mockResolvedValue({
        id: 'included-id', versionId: 'version-id', courseId: 'course-id',
        graceDays: 7, createdById: 'admin-id', createdAt: version.createdAt,
        course: { id: 'course-id', title: 'Course', slug: 'course' },
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (operation) => Array.isArray(operation) ? Promise.all(operation) : operation(tx)),
    membershipPlan: { count: jest.fn(), findMany: jest.fn() },
    serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([]) },
    course: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([{ id: 'course-id', title: 'Private course', slug: 'private-course', visibility: 'private' }]) },
  };
  const audit = { record: jest.fn() };
  const commerceProducts = {
    archiveMembershipPlanProducts: jest.fn(),
  };
  return {
    service: new MembershipAdminService(
      prisma as never,
      audit as never,
      commerceProducts as never,
    ),
    prisma,
    tx,
    audit,
    commerceProducts,
  };
}

describe('MembershipAdminService', () => {
  it('archives published versions with locks and audit while preserving historical pricing', async () => {
    const { service, tx, audit } = harness();
    tx.membershipPlanVersion.findUnique.mockResolvedValue({ ...version, status: MembershipPlanVersionStatus.published });
    tx.membershipPlanVersion.update.mockResolvedValue({ ...version, status: MembershipPlanVersionStatus.archived });
    await expect(service.archiveVersion('admin-id', 'version-id')).resolves.toMatchObject({
      status: 'ARCHIVED', baseMonthlyPriceAmountMinor: '100000',
      durationOptions: [{ effectivePriceAmountMinor: '225000' }],
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(tx.membershipPlanVersion.update.mock.invocationCallOrder[0]);
    expect(tx.membershipPlanVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: MembershipPlanVersionStatus.archived, archivedById: 'admin-id', archivedAt: expect.any(Date) },
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MEMBERSHIP_PLAN_VERSION_ARCHIVED', target: { type: 'membership_plan_version', id: 'version-id' },
    }), tx);
  });
  it('rejects archival of missing or nonpublished versions without modifying history', async () => {
    const { service, tx, audit } = harness();
    tx.membershipPlanVersion.findUnique.mockResolvedValueOnce(null);
    await expect(service.archiveVersion('admin-id', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveVersion('admin-id', 'draft')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.membershipPlanVersion.update).not.toHaveBeenCalled(); expect(audit.record).not.toHaveBeenCalled();
  });
  it('lists immutable historical terms and course/service benefits without writing', async () => {
    const { service, prisma, tx, audit } = harness();
    prisma.membershipPlan.count.mockResolvedValue(1);
    prisma.membershipPlan.findMany.mockResolvedValue([{ id: 'plan-id', code: 'GOLD', status: 'archived',
      versions: [{ ...version, serviceEntitlements: [{ id: 'entitlement', versionId: 'version-id', booleanValue: null, quota: 30n,
        definition: { id: 'definition', code: 'AI_CHAT', displayName: 'AI chat', valueType: 'metered', resetPeriod: 'calendar_month', description: null, unitLabel: 'request', displayOrder: 1 } }],
        includedCourses: [{ id: 'included', versionId: 'version-id', graceDays: 7, course: { id: 'course', title: 'Retained course', slug: 'retained' } }] }] }]);
    await expect(service.listPlans({ page: 1, pageSize: 25 })).resolves.toMatchObject({ total: 1, items: [{ status: 'ARCHIVED', versions: [{
      durationOptions: [{ effectivePriceAmountMinor: '225000' }], serviceEntitlements: [{ quota: '30' }], includedCourses: [{ graceDays: 7 }],
    }] }] });
    expect(tx.membershipPlan.update).not.toHaveBeenCalled(); expect(audit.record).not.toHaveBeenCalled();
  });
  it('archives Commerce products through the owning boundary before the plan', async () => {
    const { service, tx, commerceProducts } = harness();
    tx.membershipPlan.update.mockResolvedValue({
      id: 'plan-id', code: 'GOLD', status: 'archived',
      createdAt: version.createdAt, updatedAt: version.updatedAt,
      archivedAt: version.updatedAt, versions: [version],
    });

    await service.archivePlan('admin-id', 'plan-id');

    expect(commerceProducts.archiveMembershipPlanProducts).toHaveBeenCalledWith(
      tx,
      'admin-id',
      'plan-id',
    );
    expect(commerceProducts.archiveMembershipPlanProducts.mock.invocationCallOrder[0]).toBeLessThan(
      tx.membershipPlan.update.mock.invocationCallOrder[0],
    );
  });






  it('creates code-driven entitlement definitions with safe typed metadata', async () => {
    const { service, tx, audit } = harness();
    await expect(service.createEntitlementDefinition('admin-id', {
      code: 'ai_chat', valueType: 'METERED', resetPeriod: 'CALENDAR_MONTH',
      displayName: ' AI chat ', unitLabel: ' request ', displayOrder: 1,
    })).resolves.toMatchObject({ code: 'AI_CHAT', valueType: 'METERED', resetPeriod: 'CALENDAR_MONTH' });
    expect(tx.serviceEntitlementDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: 'AI_CHAT', displayName: 'AI chat' }),
    }));
    expect(audit.record).toHaveBeenCalledTimes(1);
  });




});
