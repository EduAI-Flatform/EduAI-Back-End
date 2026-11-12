import { AffiliateService } from './affiliate.service';
import type { AffiliatePolicy } from './affiliate-domain';
const now = new Date();
const policy: AffiliatePolicy = { enabled: true, currency: 'VND', commissionBase: 'net_paid_after_recorded_refunds', attributionModel: 'first_touch', commissionBps: 1000, attributionDays: 30, holdDays: 7, minimumWithdrawal: 0, subAffiliateEnabled: false };
function setup() {
  const visit = { id: 'visit', identityId: 'identity', policyRevisionId: 'policy', expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(Date.now() - 10000),
    identity: { ownerId: 'referrer', status: 'active', owner: { status: 'active', deletedAt: null } }, policy: { group: 'affiliate', status: 'scheduled', effectiveAt: new Date(Date.now() - 20000), content: policy } };
  const tx = {
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
describe('affiliate ownership and accrual', () => {
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
    const record = { id: 'attribution', policyRevisionId: 'policy', createdAt: new Date(now.getTime() - 1000), policy: { group: 'affiliate', content: policy }, accruals: [],
      order: { id: 'order', status: 'confirmed', fulfillmentStatus: 'fulfilled', currency: 'VND', payableAmountMinor: 1000n, confirmedSettlementId: 's',
        confirmedSettlement: { id: 's', orderId: 'order', amountMinor: 1000n, currency: 'VND', settledAt: now, kind: 'provider_collection', disposition: 'matched' }, refunds: [] } };
    tx.affiliateAttribution.findMany.mockResolvedValue([record] as any);
    await service.reconcile('owner');
    const data = tx.affiliateAccrual.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ attributionId: 'attribution', deltaMinor: 100n, commissionBps: 1000 });
    (record.accruals as any[]).push({ sourceDigest: data.sourceDigest, deltaMinor: 100n });
    await service.reconcile('owner');
    expect(tx.affiliateAccrual.create).toHaveBeenCalledTimes(1);
  });
  it('scopes performance data and exported fields to current affiliate ownership', async () => {
    const { service, tx } = setup();
    await service.list('current-owner', { page: 1, pageSize: 25, search: 'Name' });
    expect(tx.affiliateAttribution.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ identity: { ownerId: 'current-owner' }, buyer: { fullName: { contains: 'Name', mode: 'insensitive' } } }),
    }));
  });
});
