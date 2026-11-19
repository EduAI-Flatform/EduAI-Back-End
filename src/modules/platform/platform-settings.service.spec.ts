import { ConflictException } from "@nestjs/common";
import { PlatformSettingsService } from "./platform-settings.service";
import { DEFAULT_PLATFORM_SETTINGS } from "./platform-settings.defaults";
function setup() {
  const revision = {
    id: "revision",
    group: "branding",
    version: 1,
    content: DEFAULT_PLATFORM_SETTINGS.branding,
    status: "draft",
    effectiveAt: null,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ migrationVerified: false, guardsVerified: false, schemaVerified: false, runtimeVerified: false }]),
    user: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    commerceOrder: { findMany: jest.fn().mockResolvedValue([]) },
    gdsInternalTopup: { findMany: jest.fn().mockResolvedValue([]) },
    serviceEntitlementDefinition: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    platformPolicyRevision: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(revision),
      findUniqueOrThrow: jest.fn().mockResolvedValue(revision),
      create: jest.fn().mockResolvedValue(revision),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return {
    service: new PlatformSettingsService(prisma as any),
    tx,
    prisma,
    revision,
  };
}
describe("versioned platform policies", () => {
  it('prepares canonical affiliate drafts while preserving old immutable JSON and the group validator contract', async () => {
    const { service, tx } = setup();
    const old: any = structuredClone(DEFAULT_PLATFORM_SETTINGS.affiliate); delete old.ranking;
    const original = JSON.stringify(old);
    await service.create('admin', 'affiliate', old);
    expect(tx.platformPolicyRevision.create.mock.calls[0][0].data.content).toEqual({ ...old, ranking: DEFAULT_PLATFORM_SETTINGS.affiliate.ranking });
    expect(JSON.stringify(old)).toBe(original);
    tx.platformPolicyRevision.findMany.mockResolvedValue([{ id: 'legacy', group: 'affiliate', content: old }] as any);
    expect(await service.current()).toMatchObject({ settings: { affiliate: { ranking: DEFAULT_PLATFORM_SETTINGS.affiliate.ranking } }, versions: { affiliate: 'legacy' } });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
  });
  it('pairs preview provenance inside the ranking snapshot and keeps financial admission independently disabled', async () => {
    const { service, tx, prisma, revision } = setup();
    const before = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.affiliate), ranking: { enabled: true, basis: 'recorded_referral_count', period: 'lifetime', tiePolicy: 'competition' } };
    Object.assign(revision, { group: 'affiliate', content: { ...before, ranking: { ...before.ranking, period: 'utc_month' } } });
    // An earlier current read must not determine ranking's before-policy.
    tx.platformPolicyRevision.findMany.mockResolvedValue([{ id: 'stale', group: 'affiliate', content: DEFAULT_PLATFORM_SETTINGS.affiliate }] as any);
    tx.platformPolicyRevision.findFirst.mockResolvedValue({ id: 'snapshot-effective', content: before } as any);
    tx.user.findMany.mockResolvedValue([{ id: 'participant' }] as any);
    Object.assign(tx, { affiliateAttribution: { findMany: jest.fn().mockResolvedValue([]) } });
    const preview = await service.preview('revision');
    expect(preview).toMatchObject({ before, canSchedule: true, rankingImpact: { beforeRevisionId: 'snapshot-effective', afterRevisionId: 'revision', complete: true,
      newlyRanked: 0, removedParticipants: 0, unchangedRanks: 1, changedRanks: 0 } });
    const cutoff = tx.platformPolicyRevision.findFirst.mock.calls[0][0].where.effectiveAt.lte;
    expect(preview.rankingImpact?.asOf).toBe(cutoff.toISOString());
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('blocks enabled ranking even when affiliate admission is disabled, but allows disabled-after recovery and future scheduling', async () => {
    const { service, tx, revision } = setup();
    const ranking = { enabled: true, basis: 'recorded_signed_commission', period: 'lifetime', tiePolicy: 'competition' };
    const content = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.affiliate), ranking };
    Object.assign(revision, { group: 'affiliate', status: 'approved', content });
    tx.user.findMany.mockRejectedValue(new Error('private failure'));
    expect(await service.preview('revision')).toMatchObject({ canSchedule: false, blockers: ['RANKING_SOURCE_UNAVAILABLE'] });
    const future = new Date(Date.now() + 86400000);
    await expect(service.schedule('admin', 'revision', future)).rejects.toMatchObject({ response: { blockers: ['RANKING_SOURCE_UNAVAILABLE'] } });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
    tx.platformPolicyRevision.findFirst.mockResolvedValue({ id: 'unavailable-old', content } as any);
    ranking.enabled = false;
    // Frozen before fixture must remain enabled while the proposed draft disables.
    tx.platformPolicyRevision.findFirst.mockResolvedValue({ id: 'unavailable-old', content: { ...content, ranking: { ...ranking, enabled: true } } } as any);
    expect(await service.preview('revision')).toMatchObject({ canSchedule: true, rankingImpact: { complete: false, comparable: false,
      beforeRevisionId: 'unavailable-old', newlyRanked: null, changedRanks: null, activationReady: true } });
    await service.schedule('admin', 'revision', future);
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalledWith({ where: { id: 'revision', status: 'approved' }, data: { status: 'scheduled', effectiveAt: future } });
  });
  it('allows an unfunded affiliate draft but prevents scheduling it until funding is configured', async () => {
    const { service, revision, tx } = setup();
    const content = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.affiliate), enabled: true };
    Object.assign(revision, { group: 'affiliate', status: 'approved', content });
    expect(await service.preview('revision')).toMatchObject({ canSchedule: false, blockers: ['AFFILIATE_FUNDING_NOT_CONFIGURED'] });
    await expect(service.schedule('admin', 'revision', new Date(Date.now() + 60000))).rejects.toMatchObject({
      response: { blockers: ['AFFILIATE_FUNDING_NOT_CONFIGURED'] },
    });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
    content.fundingSource = 'platform_fee';
    expect(await service.preview('revision')).toMatchObject({ canSchedule: true, blockers: [] });
    content.enabled = false; content.fundingSource = 'unconfigured';
    expect(await service.preview('revision')).toMatchObject({ canSchedule: true, blockers: [] });
  });
  it('exposes the supported request catalog only in the Admin settings response', async () => {
    const { service, tx } = setup();
    tx.serviceEntitlementDefinition.findMany.mockResolvedValue([{ id: 'definition', code: 'AI_CHAT',
      valueType: 'metered', resetPeriod: 'calendar_month', unitLabel: 'request', displayName: 'Chat' }]);
    expect(await service.state()).toMatchObject({ cardServiceCapabilities: {
      supportedOperations: expect.arrayContaining(['AI_CHAT', 'AI_SUMMARY']),
      definitions: [{ id: 'definition', code: 'AI_CHAT', executable: true }],
      schemaReady: false, schemaBlocker: 'CARD_SERVICE_SCHEMA_NOT_VERIFIED',
      activationReady: false,
    } });
    expect(await service.publicSettings()).not.toHaveProperty('cardServiceCapabilities');
  });
  it('reports missing request-service bindings to Admin and prevents scheduling the same invalid configuration', async () => {
    const { service, revision, tx } = setup();
    const definitionId = '00000000-0000-4000-8000-000000000001';
    const content = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.membership), enabled: true,
      serviceLimits: { enabled: true, consumptionPriority: 'purchased_first', termAnchorAt: '', termMonths: 0 },
      tiers: DEFAULT_PLATFORM_SETTINGS.membership.tiers.map((tier, index) => ({ ...tier, threshold: index * 100,
        serviceLimits: [{ definitionId, quota: '5' }] })),
    };
    Object.assign(revision, { group: 'membership', content, status: 'approved' });
    expect(await service.preview('revision')).toMatchObject({ canSchedule: false,
      cardServiceBindings: { ready: false, issues: [{ definitionId, reason: 'CARD_SERVICE_DEFINITION_NOT_FOUND' }] },
      blockers: expect.arrayContaining(['CARD_SERVICE_DEFINITION_NOT_FOUND']),
    });
    await expect(service.schedule('actor', 'revision', new Date(Date.now() + 60000))).rejects.toMatchObject({
      response: { blockers: expect.arrayContaining(['CARD_SERVICE_DEFINITION_NOT_FOUND']) },
    });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
  });
  it('does not schedule executable card limits while physical runtime readiness is unverified', async () => {
    const { service, revision, tx } = setup();
    const content = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.membership),
      serviceLimits: { enabled: true, consumptionPriority: 'purchased_first', termAnchorAt: '', termMonths: 0 } };
    content.enabled = true; content.tiers.forEach((tier, index) => { tier.threshold = index * 100; });
    Object.assign(revision, { group: 'membership', content, status: 'approved' });
    expect(await service.preview('revision')).toMatchObject({ canSchedule: false,
      blockers: ['CARD_SERVICE_SCHEMA_NOT_VERIFIED'] });
    await expect(service.schedule('actor', 'revision', new Date(Date.now() + 86400000)))
      .rejects.toMatchObject({ response: { message: 'Activation is not ready.', blockers: ['CARD_SERVICE_SCHEMA_NOT_VERIFIED'] } });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
  });
  it('allows approved custom-tier quotas only with verified schema and executable bindings', async () => {
    const { service, revision, tx } = setup();
    const definitionId = '00000000-0000-4000-8000-000000000001';
    tx.$queryRaw.mockResolvedValue([{ migrationVerified: true, guardsVerified: true, schemaVerified: true, runtimeVerified: true }]);
    const definition = { id: definitionId, code: 'AI_CHAT', valueType: 'metered', resetPeriod: 'calendar_month', unitLabel: 'request' };
    tx.serviceEntitlementDefinition.findMany.mockResolvedValue([definition]);
    const tiers = [...DEFAULT_PLATFORM_SETTINGS.membership.tiers, { code: 'custom', name: { vi: 'Hạng thử nghiệm', en: 'Synthetic tier' }, threshold: 0, benefits: [] }];
    const content = { ...structuredClone(DEFAULT_PLATFORM_SETTINGS.membership), enabled: true,
      serviceLimits: { enabled: true, consumptionPriority: 'purchased_first', termAnchorAt: '', termMonths: 0 },
      tiers: tiers.map((tier, index) => ({ ...tier, threshold: index * 100, serviceLimits: [{ definitionId, quota: String(index + 1) }] })),
    };
    Object.assign(revision, { group: 'membership', content, status: 'approved' });
    expect(await service.preview('revision')).toMatchObject({ canSchedule: true, blockers: [],
      membershipImpact: { activationReady: true, activationBlockers: [], simulationOnly: true } });
    expect((await service.state()).cardServiceCapabilities).toMatchObject({ schemaReady: true, activationReady: true, activationBlocker: null });
    await service.schedule('admin', 'revision', new Date(Date.now() + 60000));
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'revision', status: 'approved' } }));
    tx.platformPolicyRevision.updateMany.mockClear();
    definition.unitLabel = 'unsupported';
    await expect(service.schedule('admin', 'revision', new Date(Date.now() + 60000))).rejects.toMatchObject({
      response: { blockers: ['CARD_SERVICE_REQUIRES_REQUEST_QUOTA'] },
    });
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
    expect(DEFAULT_PLATFORM_SETTINGS.membership.enabled).toBe(false);
  });
  it('does not report unchanged JSONB policy objects as changed when property order differs', async () => {
    const { service, revision } = setup();
    revision.content = Object.fromEntries(Object.entries(DEFAULT_PLATFORM_SETTINGS.branding).reverse()) as typeof revision.content;
    expect(JSON.stringify(revision.content)).not.toBe(JSON.stringify(DEFAULT_PLATFORM_SETTINGS.branding));
    expect(await service.preview('revision')).toMatchObject({ changed: false });
  });
  it('retains page cursors and snapshot completeness when returning policy readiness with impact', async () => {
    const { service, revision, tx } = setup();
    Object.assign(revision, { group: 'membership', content: structuredClone(DEFAULT_PLATFORM_SETTINGS.membership) });
    tx.user.count.mockResolvedValue(2);
    tx.user.findMany.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
    expect(await service.preview('revision', { after: 'cursor', pageSize: 1 })).toMatchObject({
      membershipImpact: { nextCursor: 'one', evaluatedUsers: 1, complete: false, simulationOnly: true, activationReady: true },
    });
    expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, id: { gt: 'cursor' } }, take: 2 }));
  });
  it('still reports changed navigation array order as a policy change', async () => {
    const { service, revision } = setup();
    Object.assign(revision, { group: 'navigation', content: [...DEFAULT_PLATFORM_SETTINGS.navigation].reverse() });
    expect(await service.preview('revision')).toMatchObject({ changed: true });
  });
  it('allows point scheduling only after the reviewed schema and bounded runtime guards verify', async () => {
    const { service, revision, tx } = setup();
    Object.assign(revision, { group: 'points', status: 'approved', content: { ...DEFAULT_PLATFORM_SETTINGS.points,
      enabled: true, rules: [{ event: 'course.completed', points: 80 }] } });
    await expect(service.schedule('admin', 'revision', new Date(Date.now() + 60000))).rejects.toThrow('Activation is not ready');
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([{ migrationVerified: true, guardsVerified: true, schemaVerified: true, runtimeVerified: true }]);
    await service.schedule('admin', 'revision', new Date(Date.now() + 60000));
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'revision', status: 'approved' } }));
    expect(DEFAULT_PLATFORM_SETTINGS.points.enabled).toBe(false);
  });
  it('previews point policy impact without awarding or rewriting prior completions', async () => {
    const { service, revision, tx } = setup();
    revision.group = 'points';
    revision.content = { ...DEFAULT_PLATFORM_SETTINGS.points, enabled: true,
      rules: [{ event: 'course.completed', points: 80 }] } as never;
    tx.enrollment.findMany.mockResolvedValue([{ id: 'completion', userId: 'learner', completedAt: new Date() }] as never);
    expect(await service.preview('revision')).toMatchObject({ pointsImpact: { status: 'evaluated', simulationOnly: true,
      sampledEvents: 1, beforePoints: 0, afterPoints: 80, historicalAwardsPreserved: true,
      beforeRevisionId: null, afterRevisionId: 'revision' }, preservesPurchasedAccess: true });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect((await service.state()).pointCapabilities.supportedEvents).toEqual(['course.completed']);
    expect(await service.publicSettings()).not.toHaveProperty('pointCapabilities');
  });
  it("publishes only effective scheduled settings and excludes private financial rules", async () => {
    const { service, tx } = setup();
    tx.platformPolicyRevision.findMany.mockResolvedValue([
      {
        group: "branding",
        id: "live",
        content: { ...DEFAULT_PLATFORM_SETTINGS.branding, name: "New GDS" },
      },
      {
        group: "branding",
        id: "old",
        content: DEFAULT_PLATFORM_SETTINGS.branding,
      },
      { group: "affiliate", id: "private", content: { commissionBps: 1234 } },
    ] as any);
    const result = await service.publicSettings();
    expect((result.settings.branding as any).name).toBe("New GDS");
    expect(result.settings).not.toHaveProperty("affiliate");
    expect(result.versions.branding).toBe("live");
    expect(tx.platformPolicyRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "scheduled", effectiveAt: { lte: expect.any(Date) } },
      }),
    );
  });
  it("creates immutable numbered drafts and an audit row atomically", async () => {
    const { service, tx, prisma } = setup();
    tx.platformPolicyRevision.findFirst.mockResolvedValue({
      version: 4,
    } as any);
    await service.create(
      "admin",
      "branding",
      DEFAULT_PLATFORM_SETTINGS.branding,
    );
    expect(tx.platformPolicyRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 5, createdById: "admin" }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "admin",
        action: "PLATFORM_POLICY_DRAFT_CREATED",
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });
  it("does not approve a concurrently changed or cancelled draft", async () => {
    const { service, tx } = setup();
    tx.platformPolicyRevision.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.approve("admin", "revision")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("allows disabling card classification and preserves purchased access in impact", async () => {
    const { service, revision, tx } = setup();
    Object.assign(revision, {
      group: "membership",
      content: DEFAULT_PLATFORM_SETTINGS.membership,
    });
    const preview = await service.preview("revision");
    expect(preview.canSchedule).toBe(true);
    expect(preview.membershipImpact?.status).toBe("evaluated");
    expect(preview.membershipImpact?.activationReady).toBe(true);
    expect(preview.membershipImpact?.activationBlockers).toEqual([]);
    await service.schedule("admin", "revision", new Date(Date.now() + 60000));
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalled();
  });
  it("supports approved top-up policies without activating defaults or removing the approval lifecycle", async () => {
    const { service, revision, tx } = setup();
    const policy = structuredClone(DEFAULT_PLATFORM_SETTINGS.membership);
    policy.enabled = true; policy.basis = 'topup'; policy.tiers[1].threshold = 100; policy.tiers[2].threshold = 200;
    Object.assign(revision, { group: 'membership', content: policy });
    await service.schedule('admin', 'revision', new Date(Date.now() + 60000));
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'revision', status: 'approved' } }));
    expect(DEFAULT_PLATFORM_SETTINGS.membership.enabled).toBe(false);
  });
  it("schedules approved presentation content and records actor/effective date", async () => {
    const { service, tx } = setup();
    const date = new Date(Date.now() + 60000);
    await service.schedule("admin", "revision", date);
    expect(tx.platformPolicyRevision.updateMany).toHaveBeenCalledWith({
      where: { id: "revision", status: "approved" },
      data: { status: "scheduled", effectiveAt: date },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PLATFORM_POLICY_SCHEDULED" }),
    });
  });
  it("does not mutate active policy history on cancellation", async () => {
    const { service, revision, tx } = setup();
    Object.assign(revision, {
      status: "scheduled",
      effectiveAt: new Date(Date.now() - 1000),
    });
    await expect(service.cancel("admin", "revision")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.platformPolicyRevision.updateMany).not.toHaveBeenCalled();
  });
  it("rejects arbitrary group content before a transaction", async () => {
    const { service, prisma } = setup();
    await expect(service.create("admin", "secrets", {})).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
