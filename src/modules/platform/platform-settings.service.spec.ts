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
    user: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    commerceOrder: { findMany: jest.fn().mockResolvedValue([]) },
    gdsInternalTopup: { findMany: jest.fn().mockResolvedValue([]) },
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
    expect(preview.membershipImpact?.activationReady).toBe(false);
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
