import { AffiliateService } from './affiliate.service';
import type { AffiliatePolicy } from './affiliate-domain';
const now = new Date();
const policy: AffiliatePolicy = { enabled: true, currency: 'VND', commissionBase: 'net_paid_after_recorded_refunds', attributionModel: 'first_touch', commissionBps: 1000, attributionDays: 30, holdDays: 7, minimumWithdrawal: 0, subAffiliateEnabled: false,
  fundingSource: 'platform_fee', allocationPrecedence: 'seller_entitlements_first' };
function setup() {
  const visit = { id: 'visit', identityId: 'identity', policyRevisionId: 'policy', expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(Date.now() - 10000),
    identity: { ownerId: 'referrer', status: 'active', owner: { status: 'active', deletedAt: null } }, policy: { group: 'affiliate', status: 'scheduled', effectiveAt: new Date(Date.now() - 20000), content: policy } };
  const tx = {
    platformPolicyRevision: { findFirst: jest.fn().mockResolvedValue({ id: 'policy', content: policy }) },
    commerceOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order', buyerId: 'buyer', status: 'pending_payment', createdAt: new Date(), confirmedSettlementId: null }) },
    affiliateVisit: { findUnique: jest.fn().mockResolvedValue(visit), create: jest.fn().mockResolvedValue({ id: 'visit' }) },
    affiliateIdentity: { findUnique: jest.fn().mockResolvedValue({ id: 'identity', status: 'active', owner: { status: 'active', deletedAt: null } }), upsert: jest.fn().mockResolvedValue({ id: 'identity' }), findMany: jest.fn().mockResolvedValue([]) },
    affiliateAttribution: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'attribution' }), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    affiliateAccrual: { aggregate: jest.fn().mockResolvedValue({ _sum: { deltaMinor: null } }), create: jest.fn().mockResolvedValue({ id: 'accrual' }) },
    auditLog: { create: jest.fn() },
  };
  const db = { ...tx, $transaction: jest.fn(async (work: any) => typeof work === 'function' ? work(tx) : Promise.all(work)) };
  const settings = { current: jest.fn().mockResolvedValue({ settings: { affiliate: policy }, versions: { affiliate: 'policy' } }) };
  const service = new AffiliateService(db as any, settings as any, { app: { publicAppUrl: 'https://gds.example.test' } } as any);
  return { service, db, tx, settings, visit };
}
function accrualRecord() {
  return { id: 'attribution', identityId: 'identity', policyRevisionId: 'policy', createdAt: new Date(now.getTime() - 1000),
    visit: { identityId: 'identity', policyRevisionId: 'policy', createdAt: new Date(now.getTime() - 2000) },
    policy: { id: 'policy', group: 'affiliate', status: 'scheduled', effectiveAt: new Date(now.getTime() - 3000), content: { ...policy } }, accruals: [] as any[],
    order: { id: 'order', status: 'confirmed', fulfillmentStatus: 'fulfilled', currency: 'VND', payableAmountMinor: 1000n, confirmedSettlementId: 's',
      confirmedSettlement: { id: 's', orderId: 'order', amountMinor: 1000n, currency: 'VND', settledAt: now, kind: 'provider_collection', disposition: 'matched' }, refunds: [] as any[] } };
}
describe('affiliate ownership and accrual', () => {
  it('reads the effective ranking revision inside the summary snapshot without consulting earlier current settings', async () => {
    const { service, tx, settings } = setup();
    const ranking = { enabled: true, basis: 'recorded_referral_count', period: 'lifetime', tiePolicy: 'competition' };
    tx.platformPolicyRevision.findFirst.mockResolvedValue({ id: 'snapshot-policy', content: { ...policy, enabled: false, ranking } } as any);
    Object.assign(tx, { user: { findMany: jest.fn().mockResolvedValue([{ id: 'owner' }, { id: 'other' }]) } });
    const result = await service.state('owner');
    expect(result).toMatchObject({ enabled: false, policyRevisionId: 'snapshot-policy', summary: { ranking: {
      status: 'available', value: 1, policyRevisionId: 'snapshot-policy', complete: true } } });
    expect(result.summary.ranking.asOf).toBe(result.summary.asOf);
    expect(tx.platformPolicyRevision.findFirst.mock.calls[0][0].where.effectiveAt.lte.toISOString()).toBe(result.summary.asOf);
    expect(settings.current).not.toHaveBeenCalled();
    expect(tx.affiliateAccrual.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result.summary.ranking)).not.toContain('other');
  });
  it('returns summary and legacy commission from the same owner snapshot without posting', async () => {
    const { service, db, tx } = setup();
    tx.affiliateAccrual.aggregate.mockResolvedValue({ _sum: { deltaMinor: -50n } } as any);
    const result = await service.state('owner');
    expect(result).toMatchObject({ accruedAmountMinor: '-50', summary: { lifetimeCommissionMinor: '-50', timeZone: 'UTC',
      ranking: { value: null }, subAffiliates: { count: null } } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    expect(tx.affiliateAccrual.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('does not admit identities or visits, or advertise readiness, without configured funding and an effective version', async () => {
    const { service, settings, tx } = setup();
    settings.current.mockResolvedValue({ settings: { affiliate: { ...policy, fundingSource: 'unconfigured' } }, versions: { affiliate: 'policy' } } as any);
    tx.platformPolicyRevision.findFirst.mockResolvedValue({ id: 'policy', content: { ...policy, fundingSource: 'unconfigured' } });
    await expect(service.identity('owner', 'general', ['student'])).rejects.toThrow('AFFILIATE_PROGRAM_DISABLED');
    await expect(service.visit('referral-code')).rejects.toThrow('AFFILIATE_PROGRAM_DISABLED');
    expect(await service.state('owner')).toMatchObject({ enabled: false });
    settings.current.mockResolvedValue({ settings: { affiliate: policy }, versions: {} } as any);
    tx.platformPolicyRevision.findFirst.mockResolvedValue(null);
    expect(await service.state('owner')).toMatchObject({ enabled: false });
    expect(tx.affiliateIdentity.upsert).not.toHaveBeenCalled();
    expect(tx.affiliateVisit.create).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured frozen visit even when the current policy has funding', async () => {
    const { service, tx, visit } = setup();
    visit.policy.content = { ...policy, fundingSource: 'unconfigured' };
    await expect(service.attribute('buyer', 'order', 'token')).rejects.toThrow('REFERRAL_POLICY_INVALID');
    expect(tx.affiliateAttribution.create).not.toHaveBeenCalled();
  });

  it('denies identity creation when policy is disabled and instructor-only code to a learner', async () => {
    const { service, settings, tx } = setup();
    await expect(service.identity('owner', 'instructor', ['student'])).rejects.toThrow('INSTRUCTOR_REFERRAL_NOT_ALLOWED');
    settings.current.mockResolvedValue({ settings: { affiliate: { ...policy, enabled: false } }, versions: {} } as any);
    await expect(service.identity('owner', 'general', ['student'])).rejects.toThrow('AFFILIATE_PROGRAM_DISABLED');
    expect(tx.affiliateIdentity.upsert).not.toHaveBeenCalled();
  });
  it('stores a hash of a server-issued expiring visit and no IP/email', async () => {
    const { service, tx } = setup();
    const result = await service.visit('referral-code');
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    const data = tx.affiliateVisit.create.mock.calls[0][0].data;
    expect(data.tokenHash).not.toBe(result.token);
    expect(data).not.toHaveProperty('ip');
    expect(data).not.toHaveProperty('email');
  });
  it('requires buyer ownership, blocks self referrals and final orders', async () => {
    const { service, tx, visit } = setup();
    tx.commerceOrder.findFirst.mockResolvedValueOnce(null);
    await expect(service.attribute('buyer', 'order', 'token')).rejects.toThrow('ORDER_NOT_FOUND');
    visit.identity.ownerId = 'buyer';
    await expect(service.attribute('buyer', 'order', 'token')).rejects.toThrow('SELF_REFERRAL_NOT_ALLOWED');
    visit.identity.ownerId = 'referrer';
    tx.commerceOrder.findFirst.mockResolvedValueOnce({ id: 'order', buyerId: 'buyer', status: 'confirmed', createdAt: new Date(), confirmedSettlementId: 's' });
    await expect(service.attribute('buyer', 'order', 'token')).rejects.toThrow('REFERRAL_ORDER_ALREADY_FINALIZED');
    expect(tx.affiliateAttribution.create).not.toHaveBeenCalled();
  });
  it('returns idempotent attribution for the same order and visit but prevents replacement', async () => {
    const { service, tx } = setup();
    tx.affiliateAttribution.findUnique.mockResolvedValue({ id: 'existing', visitId: 'visit', buyerId: 'buyer' } as any);
    await expect(service.attribute('buyer', 'order', 'token')).resolves.toMatchObject({ id: 'existing', attributed: true });
    tx.affiliateAttribution.findUnique.mockResolvedValue({ id: 'existing', visitId: 'other', buyerId: 'buyer' } as any);
    await expect(service.attribute('buyer', 'order', 'token')).rejects.toThrow('ORDER_REFERRAL_ALREADY_ATTRIBUTED');
  });
  it('keeps spendable balances unavailable even when actual business accrual is zero', async () => {
    const { service } = setup();
    expect(await service.state('owner')).toMatchObject({ totalReferrals: 0, accruedAmountMinor: '0', availableBalanceMinor: null, withdrawalEnabled: false });
  });
  it('appends one source adjustment and never writes a wallet', async () => {
    const { service, tx } = setup();
    const record = accrualRecord();
    tx.affiliateAttribution.findMany.mockResolvedValue([record] as any);
    await service.reconcile('owner');
    const data = tx.affiliateAccrual.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ attributionId: 'attribution', deltaMinor: 100n, commissionBps: 1000 });
    (record.accruals as any[]).push({ sourceDigest: data.sourceDigest, deltaMinor: 100n });
    await service.reconcile('owner');
    expect(tx.affiliateAccrual.create).toHaveBeenCalledTimes(1);
  });
  it.each(['unconfigured', 'draft', 'ineffective visit', 'different visit policy', 'different visit identity'])('does not append positive accrual for %s provenance', async invalid => {
    const { service, tx } = setup();
    const record = accrualRecord();
    if (invalid === 'unconfigured') record.policy.content.fundingSource = 'unconfigured';
    if (invalid === 'draft') record.policy.status = 'draft';
    if (invalid === 'ineffective visit') record.policy.effectiveAt = new Date(now.getTime() - 1500);
    if (invalid === 'different visit policy') record.visit.policyRevisionId = 'other';
    if (invalid === 'different visit identity') record.visit.identityId = 'other';
    tx.affiliateAttribution.findMany.mockResolvedValue([record] as never);
    expect(await service.reconcile('owner')).toMatchObject({ items: [{ status: 'unavailable', reason: 'REFERRAL_POLICY_INVALID' }] });
    expect(tx.affiliateAccrual.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('preserves history and appends only the canonical negative refund correction for an old unfunded policy', async () => {
    const { service, tx, settings } = setup();
    const record = accrualRecord();
    record.policy.content.fundingSource = 'unconfigured';
    record.accruals.push({ sourceDigest: 'historical', deltaMinor: 100n });
    record.order.refunds.push({ id: 'refund', settlementId: 's', status: 'recorded', currency: 'VND', amountMinor: 500n, recordedAt: now });
    settings.current.mockResolvedValue({ settings: { affiliate: { ...policy, enabled: false } }, versions: {} } as never);
    tx.affiliateAttribution.findMany.mockResolvedValue([record] as never);
    await service.reconcile('owner');
    const data = tx.affiliateAccrual.create.mock.calls[0][0].data;
    expect(data.deltaMinor).toBe(-50n);
    record.accruals.push(data);
    await service.reconcile('owner');
    expect(tx.affiliateAccrual.create).toHaveBeenCalledTimes(1);
    expect(record.accruals[0]).toEqual({ sourceDigest: 'historical', deltaMinor: 100n });
  });
  it('uses the historically admitted version even when current participation is disabled', async () => {
    const { service, tx, settings } = setup();
    settings.current.mockResolvedValue({ settings: { affiliate: { ...policy, enabled: false } }, versions: {} } as never);
    tx.affiliateAttribution.findMany.mockResolvedValue([accrualRecord()] as never);
    await service.reconcile('owner');
    expect(tx.affiliateAccrual.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deltaMinor: 100n }) }));
  });
  it('scopes performance data and exported fields to current affiliate ownership', async () => {
    const { service, tx } = setup();
    await service.list('current-owner', { page: 1, pageSize: 25, search: 'Name' });
    expect(tx.affiliateAttribution.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ identity: { ownerId: 'current-owner' }, buyer: { fullName: { contains: 'Name', mode: 'insensitive' } } }),
    }));
  });
});
