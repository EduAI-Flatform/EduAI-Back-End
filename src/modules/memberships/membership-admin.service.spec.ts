import { BadRequestException, ConflictException } from '@nestjs/common';
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

const input = {
  code: 'gold',
  displayName: ' Gold ',
  baseMonthlyPriceAmountMinor: '100000',
  currency: 'VND' as const,
  durations: [{ months: 3, discountPercent: 25, displayOrder: 0 }],
};

describe('MembershipAdminService', () => {
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

  it('creates an arbitrary stable plan and version with string-money output', async () => {
    const { service, tx, audit } = harness();

    await expect(service.createPlan('admin-id', input)).resolves.toMatchObject({
      code: 'GOLD',
      versions: [
        {
          displayName: 'Gold',
          baseMonthlyPriceAmountMinor: '100000',
          durationOptions: [{ effectivePriceAmountMinor: '225000' }],
        },
      ],
    });
    expect(tx.membershipPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'GOLD',
          versions: {
            create: expect.objectContaining({
              baseMonthlyPriceAmountMinor: 100_000n,
              durationOptions: {
                create: [
                  expect.objectContaining({ months: 3, discountPercent: 25 }),
                ],
              },
            }),
          },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('lists bounded published clear courses without excluding private visibility', async () => {
    const { service, prisma } = harness();
    await expect(service.listAvailableCourses({ page: 1, pageSize: 25, search: 'Private' })).resolves.toEqual({
      items: [{ id: 'course-id', title: 'Private course', slug: 'private-course', visibility: 'PRIVATE' }],
      page: 1, pageSize: 25, total: 1, totalPages: 1,
    });
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null, status: 'published', moderationStatus: 'clear' }),
      take: 25,
    }));
  });

  it('serializes version numbering and creates a new version instead of editing history', async () => {
    const { service, tx } = harness();

    await service.createVersion('admin-id', 'plan-id', input);

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.membershipPlanVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ versionNumber: 2 }) }),
    );
  });

  it('publishes a draft once and rejects mutation of published history', async () => {
    const { service, tx } = harness();
    await expect(service.publishVersion('admin-id', 'version-id')).resolves.toMatchObject({
      status: 'PUBLISHED',
    });

    tx.membershipPlanVersion.findUnique.mockResolvedValueOnce({
      ...version,
      status: MembershipPlanVersionStatus.published,
    });
    await expect(service.publishVersion('admin-id', 'version-id')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects monetary input outside the PostgreSQL 64-bit range', async () => {
    const { service } = harness();

    expect(() =>
      service.createPlan('admin-id', {
        ...input,
        baseMonthlyPriceAmountMinor: '9223372036854775808',
      }),
    ).toThrow(BadRequestException);
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

  it('configures a draft version from definition semantics and string quota', async () => {
    const { service, tx } = harness();
    await expect(service.configurePlanEntitlement('admin-id', 'version-id', {
      definitionId: 'definition-id', quota: '30',
    })).resolves.toMatchObject({ quota: '30', definition: { code: 'AI_CHAT' } });
    expect(tx.membershipPlanEntitlement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ valueType: 'metered', resetPeriod: 'calendar_month', quota: 30n }),
    }));
  });

  it('rejects configuration whose value does not match the stable definition', async () => {
    const { service } = harness();
    await expect(service.configurePlanEntitlement('admin-id', 'version-id', {
      definitionId: 'definition-id', booleanValue: true,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('snapshots an explicit available course only on a draft version', async () => {
    const { service, tx } = harness();
    await expect(service.configureIncludedCourse('admin-id', 'version-id', {
      courseId: '10000000-0000-4000-8000-000000000001', graceDays: 7,
    })).resolves.toMatchObject({ graceDays: 7, course: { slug: 'course' } });
    expect(tx.membershipPlanIncludedCourse.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'version-id', graceDays: 7 }),
    }));
  });
});
