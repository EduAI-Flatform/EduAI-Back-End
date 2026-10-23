import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ServiceEntitlementGrantStatus,
  ServiceEntitlementResetPeriod,
  ServiceEntitlementValueType,
} from '../../../generated/prisma/client';
import { ServiceEntitlementService } from './service-entitlement.service';
import { ensureReceiptQuotaPool } from './receipt-quota-pool';

const now = new Date('2026-08-24T12:00:00.000Z');

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-id', userId: 'student-id', definitionId: 'definition-id',
    sourceType: 'MEMBERSHIP_TERM', sourceId: 'term-id', quotaPoolId: null,
    valueType: ServiceEntitlementValueType.metered,
    resetPeriod: ServiceEntitlementResetPeriod.calendar_month,
    booleanValue: null, quota: 3n,
    status: ServiceEntitlementGrantStatus.active,
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'), revokedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    definition: {
      id: 'definition-id', code: 'AI_CHAT', displayName: 'AI chat',
      description: null, unitLabel: 'request', displayOrder: 0,
      valueType: ServiceEntitlementValueType.metered,
      resetPeriod: ServiceEntitlementResetPeriod.calendar_month,
    },
    ...overrides,
  };
}

function harness(grants = [grant()]) {
  let used = 0n;
  const findGrants = jest.fn(async ({ where }: { where: { definition?: { code: string }; endsAt?: unknown } }) =>
    grants.filter((item) =>
      (!where.definition || item.definition.code === where.definition.code)
      && item.startsAt <= now
      && (item.endsAt === null || item.endsAt > now),
    ));
  const tx = {
    $queryRaw: jest.fn(),
    serviceEntitlementUsage: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn(async () => ({ _sum: { quantity: used } })),
      create: jest.fn(async ({ data }: { data: { quantity: bigint } }) => {
        used += data.quantity;
        return { id: 'usage-id', ...data, createdAt: now };
      }),
    },
    serviceEntitlementGrant: { findMany: findGrants, createMany: jest.fn() },
    membershipPlanEntitlement: { findMany: jest.fn().mockResolvedValue([]) },
    commerceReceiptAccessEffect: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    $transaction: jest.fn(async (operation) => operation(tx)),
    serviceEntitlementGrant: { findMany: findGrants },
    serviceEntitlementUsage: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: 0n } }) },
    commerceReceiptAccessEffect: tx.commerceReceiptAccessEffect,
  };
  const config = { app: { nodeEnv: 'test' }, commerce: { idempotencySecret: 's'.repeat(32) } };
  return { service: new ServiceEntitlementService(prisma as never, config as never), tx };
}

describe('ServiceEntitlementService', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const earlyFlags = () => {
    process.env.BANK_TRANSFER_SANDBOX_ENABLED = 'true';
    process.env.BANK_RECEIPT_SANDBOX_ENABLED = 'true';
    process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED = 'true';
    process.env.BANK_RECEIPT_SYNTHETIC_BUYER_IDS = 'student-id';
  };
  it('immediately excludes early service grants when the capability is OFF', async () => {
    delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
    const { service, tx } = harness([grant({ sourceType: 'UNVERIFIED_RECEIPT_ACCESS', sourceId: 'generation:line', quotaPoolId: 'pool-id' })]);
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'early-off-operation', now)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.serviceEntitlementUsage.create).not.toHaveBeenCalled();
  });
  it('requires the exact active receipt generation effect for early service usage', async () => {
    earlyFlags();
    const { service, tx } = harness([grant({ sourceType: 'UNVERIFIED_RECEIPT_ACCESS', sourceId: 'generation:line', quotaPoolId: 'pool-id' })]);
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'early-no-effect-0001', now)).rejects.toBeInstanceOf(ForbiddenException);
    tx.commerceReceiptAccessEffect.findMany.mockResolvedValue([{ resourceId: 'grant-id', generationId: 'generation', orderLineId: 'wrong-line' }]);
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'early-wrong-line-0002', now)).rejects.toBeInstanceOf(ForbiddenException);
    tx.commerceReceiptAccessEffect.findMany.mockResolvedValue([{ resourceId: 'grant-id', generationId: 'generation', orderLineId: 'line' }]);
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'early-right-effect-0003', now)).resolves.toMatchObject({ remaining: '2' });
    expect(tx.commerceReceiptAccessEffect.findMany).toHaveBeenLastCalledWith({ where: {
      resourceType: 'service_entitlement_grant', resourceId: { in: ['grant-id'] },
      generation: { buyerId: 'student-id', status: 'ACCESS_UNVERIFIED' },
    }, select: { resourceId: true, generationId: true, orderLineId: true } });
  });
  it('preserves spent quota when restored and canonical paid grants share the same pool', async () => {
    earlyFlags();
    const grants = [grant({ quotaPoolId: 'pool-id', id: 'early-grant', sourceType: 'UNVERIFIED_RECEIPT_ACCESS', sourceId: 'generation-1:line' })];
    const { service, tx } = harness(grants);
    tx.commerceReceiptAccessEffect.findMany.mockResolvedValue([{ resourceId: 'early-grant', generationId: 'generation-1', orderLineId: 'line' }]);
    await expect(service.consume('student-id', 'AI_CHAT', 2n, 'pool-operation-0001', now)).resolves.toMatchObject({ remaining: '1' });
    grants[0] = grant({ quotaPoolId: 'pool-id', id: 'restored-grant', sourceType: 'UNVERIFIED_RECEIPT_ACCESS', sourceId: 'generation-2:line' });
    tx.commerceReceiptAccessEffect.findMany.mockResolvedValue([{ resourceId: 'restored-grant', generationId: 'generation-2', orderLineId: 'line' }]);
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'pool-operation-0002', now)).resolves.toMatchObject({ remaining: '0' });
    grants[0] = grant({ quotaPoolId: 'pool-id', id: 'paid-grant', sourceType: 'membership' });
    delete process.env.BANK_RECEIPT_EARLY_ACCESS_ENABLED;
    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'pool-operation-0003', now)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.serviceEntitlementUsage.aggregate).toHaveBeenLastCalledWith({ where: {
      grant: { quotaPoolId: 'pool-id' }, periodStartsAt: new Date('2026-08-01T00:00:00.000Z'), periodEndsAt: new Date('2026-09-01T00:00:00.000Z'),
    }, _sum: { quantity: true } });
  });
  it('preserves the original per-grant predicate for legacy nonpooled rights', async () => {
    const { service, tx } = harness();
    await service.consume('student-id', 'AI_CHAT', 1n, 'legacy-operation-0001', now);
    expect(tx.serviceEntitlementUsage.aggregate).toHaveBeenCalledWith({ where: {
      grantId: 'grant-id', periodStartsAt: new Date('2026-08-01T00:00:00.000Z'), periodEndsAt: new Date('2026-09-01T00:00:00.000Z'),
    }, _sum: { quantity: true } });
  });
  it('resolves boolean and unlimited grants with typed safe output', async () => {
    const booleanGrant = grant({
      id: 'boolean-grant', valueType: ServiceEntitlementValueType.boolean,
      resetPeriod: ServiceEntitlementResetPeriod.none, booleanValue: false, quota: null,
      definition: { ...grant().definition, code: 'CERTIFICATE', valueType: ServiceEntitlementValueType.boolean, resetPeriod: ServiceEntitlementResetPeriod.none },
    });
    const unlimitedGrant = grant({
      id: 'unlimited-grant', valueType: ServiceEntitlementValueType.unlimited,
      resetPeriod: ServiceEntitlementResetPeriod.none, booleanValue: null, quota: null,
      definition: { ...grant().definition, code: 'RESOURCES', valueType: ServiceEntitlementValueType.unlimited, resetPeriod: ServiceEntitlementResetPeriod.none },
    });
    const { service } = harness([booleanGrant, unlimitedGrant]);

    await expect(service.resolve('student-id', 'CERTIFICATE', now)).resolves.toMatchObject({ allowed: false, code: 'CERTIFICATE' });
    await expect(service.resolve('student-id', 'RESOURCES', now)).resolves.toMatchObject({ allowed: true, remaining: null });
  });

  it('atomically consumes quota and returns the remaining string amount', async () => {
    const { service, tx } = harness();

    await expect(service.consume('student-id', 'AI_CHAT', 2n, 'operation-key-0001', now))
      .resolves.toMatchObject({ allowed: true, consumed: '2', remaining: '1' });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.serviceEntitlementUsage.create).toHaveBeenCalledTimes(1);
  });

  it('rejects exhausted quota without appending usage', async () => {
    const { service, tx } = harness();
    tx.serviceEntitlementUsage.aggregate.mockResolvedValue({ _sum: { quantity: 3n } });

    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'operation-key-0002', now))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.serviceEntitlementUsage.create).not.toHaveBeenCalled();
  });

  it('returns an idempotent replay and rejects key reuse with changed input', async () => {
    const { service, tx } = harness();
    const keyHash = service.operationKeyHash('operation-key-0003');
    tx.serviceEntitlementUsage.findUnique.mockResolvedValue({
      id: 'usage-id', userId: 'student-id', grantId: 'grant-id', quantity: 1n,
      operationKeyHash: keyHash,
      requestHash: service.requestHash('AI_CHAT', 1n),
      remainingAfter: 2n,
      periodStartsAt: new Date('2026-08-01T00:00:00.000Z'),
      periodEndsAt: new Date('2026-09-01T00:00:00.000Z'), createdAt: now,
    });

    await expect(service.consume('student-id', 'AI_CHAT', 1n, 'operation-key-0003', now))
      .resolves.toMatchObject({ idempotent: true, consumed: '1', remaining: '2' });
    await expect(service.consume('student-id', 'AI_CHAT', 2n, 'operation-key-0003', now))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('denies expired grants', async () => {
    const { service } = harness([grant({ endsAt: new Date('2026-08-24T11:59:59.000Z') })]);
    await expect(service.resolve('student-id', 'AI_CHAT', now)).resolves.toMatchObject({ allowed: false, reason: 'ENTITLEMENT_EXPIRED_OR_MISSING' });
  });

  it('provisions idempotent grants from plan configuration for later fulfillment adoption', async () => {
    const { service, tx } = harness();
    tx.membershipPlanEntitlement.findMany.mockResolvedValue([{
      definitionId: 'definition-id', valueType: ServiceEntitlementValueType.metered,
      resetPeriod: ServiceEntitlementResetPeriod.membership_term,
      booleanValue: null, quota: 10n,
    }]);
    tx.serviceEntitlementGrant.createMany = jest.fn().mockResolvedValue({ count: 1 });
    tx.serviceEntitlementGrant.findMany = jest.fn().mockResolvedValue([grant()]);

    await service.provisionFromPlanVersion({
      userId: 'student-id', versionId: 'version-id', sourceType: 'MEMBERSHIP_TERM',
      sourceId: 'term-id', startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
    }, tx as never);

    expect(tx.serviceEntitlementGrant.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('serializes concurrent final-unit consumption so only one request succeeds', async () => {
    const { service, tx } = harness();
    let used = 2n;
    tx.serviceEntitlementUsage.aggregate.mockImplementation(async () => ({ _sum: { quantity: used } }));
    tx.serviceEntitlementUsage.create.mockImplementation(async ({ data }: { data: { quantity: bigint } }) => {
      used += data.quantity;
      return { id: 'usage-id', ...data, createdAt: now };
    });
    let queue = Promise.resolve();
    (service as unknown as { prisma: { $transaction: (operation: (client: unknown) => Promise<unknown>) => Promise<unknown> } }).prisma.$transaction = (operation) => {
      const result = queue.then(() => operation(tx));
      queue = result.then(() => undefined, () => undefined);
      return result;
    };

    const outcomes = await Promise.allSettled([
      service.consume('student-id', 'AI_CHAT', 1n, 'concurrent-key-0001', now),
      service.consume('student-id', 'AI_CHAT', 1n, 'concurrent-key-0002', now),
    ]);
    expect(outcomes.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('ensureReceiptQuotaPool', () => {
  const input = { orderLineId: 'line-id', userId: 'student-id', definitionId: 'definition-id',
    valueType: ServiceEntitlementValueType.metered, resetPeriod: ServiceEntitlementResetPeriod.membership_term,
    booleanValue: null, quota: 3n, startsAt: new Date('2026-08-01'), endsAt: new Date('2026-09-01') };
  it('idempotently reuses the exact pool without mutating its snapshot', async () => {
    const tx = { serviceEntitlementQuotaPool: { createMany: jest.fn(), findUnique: jest.fn(async () => ({ id: 'pool-id', ...input })) } };
    await expect(ensureReceiptQuotaPool(tx as never, input)).resolves.toEqual({ id: 'pool-id' });
    expect(tx.serviceEntitlementQuotaPool.createMany).toHaveBeenCalledWith({ data: [input], skipDuplicates: true });
  });
  it.each([{ quota: 4n }, { userId: 'other-user' }, { endsAt: null }, { startsAt: new Date('2026-08-02') }])(
    'rejects an existing pool with different immutable facts', async (mismatch) => {
      const tx = { serviceEntitlementQuotaPool: { createMany: jest.fn(), findUnique: jest.fn(async () => ({ id: 'pool-id', ...input, ...mismatch })) } };
      await expect(ensureReceiptQuotaPool(tx as never, input)).rejects.toBeInstanceOf(ConflictException);
    });
});
