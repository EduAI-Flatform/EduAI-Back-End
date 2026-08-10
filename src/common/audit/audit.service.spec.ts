import { AuditAction, AuditService } from './audit.service';

describe('AuditService', () => {
  const auditRecord = {
    id: 'audit-id',
    actorId: 'actor-id',
    action: AuditAction.AuthLogin,
    targetType: 'user',
    targetId: 'actor-id',
    metadataJson: { provider: 'local' },
    occurredAt: new Date('2026-08-10T00:00:00.000Z'),
    actor: {
      id: 'actor-id',
      email: 'admin@example.com',
      fullName: 'Admin',
    },
  };

  function createHarness() {
    const prisma = {
      auditLog: {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue(auditRecord),
        findMany: jest.fn().mockResolvedValue([auditRecord]),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    };

    return {
      prisma,
      service: new AuditService(prisma as never),
    };
  }

  it('appends a sanitized record without exposing a mutation API', async () => {
    const { prisma, service } = createHarness();

    await service.record({
      actorId: 'actor-id',
      action: AuditAction.AuthLogin,
      target: { type: 'user', id: 'actor-id' },
      metadata: {
        provider: 'local',
        password: 'must-not-persist',
        nested: {
          accessToken: 'must-not-persist',
          safeCount: 2,
        },
      },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'actor-id',
        action: AuditAction.AuthLogin,
        targetType: 'user',
        targetId: 'actor-id',
        metadataJson: {
          provider: 'local',
          nested: { safeCount: 2 },
        },
      },
      select: { id: true },
    });
    expect('update' in service).toBe(false);
    expect('delete' in service).toBe(false);
  });

  it('returns newest-first paginated records with bounded filters', async () => {
    const { prisma, service } = createHarness();

    await expect(
      service.list({
        page: 2,
        pageSize: 25,
        search: 'course',
        action: AuditAction.CoursePublished,
        targetType: 'course',
        occurredAfter: '2026-08-01T00:00:00.000Z',
        occurredBefore: '2026-08-11T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      items: [auditRecord],
      page: 2,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: 25,
        take: 25,
        where: expect.objectContaining({
          action: AuditAction.CoursePublished,
          targetType: 'course',
          occurredAt: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lte: new Date('2026-08-11T00:00:00.000Z'),
          },
        }),
      }),
    );
  });
});
