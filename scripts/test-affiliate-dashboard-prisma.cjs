'use strict';
// Read-model acceptance only: synthetic historical accruals (including refund corrections),
// NOT evidence that pending orders earn commission. Canonical paid/refund fixtures below
// use synthetic stored provider proof and real fulfillment/refund services, never a provider API.
// No reconciliation or wallet posting occurs.
// Immutable fixtures intentionally remain until the disposable CI database is destroyed.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
let checkpoint = 'guard';
async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  assert.equal(url.search, ''); // Disallow connection-string query overrides of host/database.
  assert.equal(url.hash, '');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { AffiliateService } = require('../dist/src/modules/affiliate/affiliate.service.js');
  const { PlatformSettingsService } = require('../dist/src/modules/platform/platform-settings.service.js');
  const { DEFAULT_PLATFORM_SETTINGS } = require('../dist/src/modules/platform/platform-settings.defaults.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { CourseAccessService } = require('../dist/src/modules/access/course-access.service.js');
  const { CommerceFulfillmentService } = require('../dist/src/modules/payments/commerce-fulfillment.service.js');
  const { PaymentRefundService } = require('../dist/src/modules/payments/payment-refund.service.js');
  const QRCode = require('qrcode');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const digest = text => createHash('sha256').update(text).digest('hex');
  try {
    checkpoint = 'fixture.users';
    const [owner, other, empty, buyer, tied] = await Promise.all(['owner', 'other', 'empty', 'buyer', 'tied'].map(label => db.user.create({
      data: { email: `${randomUUID()}@synthetic.invalid`, fullName: `Synthetic dashboard ${label}` },
    })));
    checkpoint = 'fixture.policy';
    const version = (await db.platformPolicyRevision.aggregate({ where: { group: 'affiliate' }, _max: { version: true } }))._max.version ?? 0;
    const legacyAffiliate = { ...DEFAULT_PLATFORM_SETTINGS.affiliate, enabled: false };
    delete legacyAffiliate.ranking; // Actual old immutable JSON compatibility fixture.
    const revision = await db.platformPolicyRevision.create({ data: { group: 'affiliate', version: version + 1,
      status: 'scheduled', createdById: owner.id, approvedById: owner.id, approvedAt: new Date(), effectiveAt: new Date(),
      content: legacyAffiliate,
    } });
    checkpoint = 'fixture.identities';
    const identities = await Promise.all([[owner, 'general'], [owner, 'instructor'], [other, 'general'], [tied, 'general']].map(([user, kind]) =>
      db.affiliateIdentity.create({ data: { ownerId: user.id, kind, code: randomUUID().replaceAll('-', '').slice(0, 30) } })));
    // A current general identity qualifies the owner; retained inactive instructor
    // history still contributes. General identity owners have no required student role.
    await db.affiliateIdentity.update({ where: { id: identities[1].id }, data: { status: 'suspended' } });
    checkpoint = 'fixture.product';
    const course = await db.course.create({ data: { title: 'Synthetic dashboard course', slug: randomUUID(),
      instructorId: owner.id, level: 'beginner', status: 'published', visibility: 'public', priceAmountMinor: 1000000, priceCurrency: 'VND' } });
    const product = await db.commerceProduct.create({ data: { type: 'course', courseId: course.id, sellerId: owner.id, status: 'draft' } });
    await db.commerceProduct.update({ where: { id: product.id }, data: { status: 'active' } });
    // Owner: 120000 - 45000 + 5000 = 80000; other: 7000 - 12000 = -5000.
    // A no-accrual attribution still counts; neither visits nor accrual rows are referral counts.
    for (const [index, deltas] of [[0, [120000n, -45000n]], [1, [5000n]], [0, []], [2, [7000n, -12000n]], [3, [80000n]]]) {
      const identity = identities[index];
      checkpoint = 'fixture.visit';
      const visit = await db.affiliateVisit.create({ data: { identityId: identity.id, policyRevisionId: revision.id,
        tokenHash: digest(randomUUID()), expiresAt: new Date(Date.now() + 86400000) } });
      checkpoint = 'fixture.order';
      // Deferred order-total guards require matching immutable lines at commit.
      const order = await db.$transaction(async tx => {
        const row = await tx.commerceOrder.create({ data: { buyerId: buyer.id, orderNumber: 'dashboard-' + randomUUID().slice(0, 20),
          subtotalAmountMinor: 1000000n, payableAmountMinor: 1000000n, pricingPolicyVersion: 'synthetic-read-model' } });
        await tx.commerceOrderLine.create({ data: { orderId: row.id, productId: product.id, productType: 'course',
          productReferenceId: course.id, sellerId: owner.id, displayTitle: course.title, currency: 'VND',
          unitListPriceAmountMinor: 1000000n, subtotalAmountMinor: 1000000n, discountAmountMinor: 0n, finalAmountMinor: 1000000n } });
        return row;
      });
      checkpoint = 'fixture.attribution';
      const attribution = await db.affiliateAttribution.create({ data: { identityId: identity.id, visitId: visit.id,
        buyerId: buyer.id, orderId: order.id, policyRevisionId: revision.id } });
      checkpoint = 'fixture.accrual';
      for (const deltaMinor of deltas) await db.affiliateAccrual.create({ data: { attributionId: attribution.id,
        sourceDigest: digest(`${deltaMinor < 0n ? 'historical-refund-correction' : 'historical-accrual'}-${randomUUID()}`),
        deltaMinor, qualifyingAmountMinor: 1000000n, commissionBps: 1000, currency: 'VND', holdUntil: new Date(0) } });
    }
    // Unattributed visit must not inflate the dashboard count.
    await db.affiliateVisit.create({ data: { identityId: identities[0].id, policyRevisionId: revision.id,
      tokenHash: digest(randomUUID()), expiresAt: new Date(Date.now() + 86400000) } });
    const snapshot = async () => {
      const ownerIds = [owner.id, other.id, empty.id, buyer.id, tied.id];
      return {
        identities: await db.affiliateIdentity.findMany({ where: { ownerId: { in: ownerIds } }, orderBy: { id: 'asc' } }),
        visits: await db.affiliateVisit.findMany({ where: { identity: { ownerId: { in: ownerIds } } }, orderBy: { id: 'asc' } }),
        attributions: await db.affiliateAttribution.findMany({ where: { identity: { ownerId: { in: ownerIds } } }, orderBy: { id: 'asc' } }),
        accruals: await db.affiliateAccrual.findMany({ where: { attribution: { identity: { ownerId: { in: ownerIds } } } }, orderBy: { id: 'asc' } }),
        orders: await db.commerceOrder.findMany({ where: { buyerId: buyer.id }, orderBy: { id: 'asc' } }),
        lines: await db.commerceOrderLine.findMany({ where: { order: { buyerId: buyer.id } }, orderBy: { id: 'asc' } }),
        walletCount: await db.gdsInternalWallet.count({ where: { buyerId: { in: ownerIds } } }),
        audits: await db.auditLog.findMany({ where: { actorId: { in: ownerIds } }, orderBy: { id: 'asc' } }),
      };
    };
    checkpoint = 'snapshot.before';
    const before = await snapshot();
    const config = { app: { publicAppUrl: 'https://dashboard.example.test', nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: false } };
    const settings = new PlatformSettingsService(db);
    const service = new AffiliateService(db, settings, config);
    checkpoint = 'read.states';
    for (const [user, count, amount, identityCount] of [[owner, 3, '80000', 2], [other, 1, '-5000', 1], [empty, 0, '0', 0]]) {
      const state = await service.state(user.id);
      assert.equal(state.enabled, false); assert.equal(state.policyRevisionId, revision.id);
      assert.equal(state.totalReferrals, count); assert.equal(state.accruedAmountMinor, amount);
      assert.equal(state.summary.lifetimeCommissionMinor, amount);
      assert.equal(state.summary.timeZone, 'UTC');
      assert.equal(state.summary.commissionStatus, 'available');
      for (const period of [state.summary.today, state.summary.month]) {
        assert.equal(period.endsBefore, state.summary.asOf);
        const expected = before.accruals.filter(row => before.attributions.some(attribution => attribution.id === row.attributionId
          && before.identities.some(identity => identity.id === attribution.identityId && identity.ownerId === user.id)))
          .filter(row => row.createdAt >= new Date(period.startsAt) && row.createdAt < new Date(period.endsBefore))
          .reduce((sum, row) => sum + row.deltaMinor, 0n).toString();
        assert.equal(period.amountMinor, expected);
      }
      assert.equal(state.summary.revenue.status, 'available');
      assert.equal(state.summary.revenue.amountMinor, '0'); // These synthetic orders are still pending.
      assert.equal(state.summary.ranking.value, null); assert.equal(state.summary.subAffiliates.count, null);
      assert.equal(state.identities.length, identityCount); assert.equal(state.currency, 'VND');
      for (const key of ['availableBalanceMinor', 'heldBalanceMinor', 'debtMinor']) assert.equal(state[key], null);
      assert.equal(state.withdrawalEnabled, false); assert.equal(state.subAffiliateEnabled, false);
      for (const identity of state.identities) {
        assert.ok(identities.some(row => row.ownerId === user.id && row.id === identity.id));
        const expected = `https://dashboard.example.test/?ref=${identity.code}`;
        assert.equal(identity.referralUrl, expected);
        assert.equal(identity.qrCodeDataUrl, await QRCode.toDataURL(expected, { width: 180, margin: 2 }));
        assert.match(identity.qrCodeDataUrl, /^data:image\/png;base64,/);
      }
    }
    const noPublicUrl = new AffiliateService(db, settings, { ...config, app: { ...config.app, publicAppUrl: undefined } });
    const noQr = await noPublicUrl.state(owner.id);
    assert.equal(noQr.accruedAmountMinor, '80000');
    assert.ok(noQr.identities.every(row => row.referralUrl === null && row.qrCodeDataUrl === null));
    // A connected adapter with money reads disabled must also return unavailable, never fabricated zero.
    const disabledWallet = new AffiliateService(db, settings, config, {});
    assert.equal((await disabledWallet.state(owner.id)).availableBalanceMinor, null);
    await assert.rejects(() => service.identity(owner.id, 'general', ['student']), /AFFILIATE_PROGRAM_DISABLED/);
    assert.deepEqual(await snapshot(), before);

    checkpoint = 'ranking.policy';
    const rankingPolicy = { enabled: true, basis: 'recorded_signed_commission', period: 'lifetime', tiePolicy: 'competition' };
    const draft = await settings.create(owner.id, 'affiliate', { ...legacyAffiliate, ranking: rankingPolicy });
    const policyBeforeApproval = await service.state(owner.id);
    assert.equal(policyBeforeApproval.summary.ranking.status, 'unconfigured');
    assert.equal(policyBeforeApproval.summary.ranking.policyRevisionId, revision.id);
    await settings.approve(owner.id, draft.id);
    assert.equal((await service.state(owner.id)).summary.ranking.status, 'unconfigured');
    const futureDraft = await settings.create(owner.id, 'affiliate', { ...legacyAffiliate,
      ranking: { ...rankingPolicy, period: 'utc_day' } });
    await settings.approve(owner.id, futureDraft.id);
    await settings.schedule(owner.id, futureDraft.id, new Date(Date.now() + 86400000));
    assert.equal((await service.state(owner.id)).summary.ranking.policyRevisionId, revision.id);
    const enabledImpact = await settings.preview(draft.id);
    assert.equal(enabledImpact.rankingImpact.beforeRevisionId, revision.id);
    assert.equal(enabledImpact.rankingImpact.afterRevisionId, draft.id);
    assert.equal(enabledImpact.rankingImpact.complete, true);
    assert.ok(enabledImpact.rankingImpact.newlyRanked >= 3);
    assert.equal(enabledImpact.rankingImpact.changedRanks, 0);
    await settings.schedule(owner.id, draft.id, new Date());
    assert.deepEqual((await db.platformPolicyRevision.findUnique({ where: { id: revision.id } })).content, legacyAffiliate);
    // Add an actual zero-score participant and an instructor-only identity without
    // its current role. These fixture writes precede the immutable-read snapshot.
    const zeroIdentity = await db.affiliateIdentity.create({ data: { ownerId: buyer.id, kind: 'general', code: randomUUID().replaceAll('-', '') } });
    const instructorIdentity = await db.affiliateIdentity.create({ data: { ownerId: empty.id, kind: 'instructor', code: randomUUID().replaceAll('-', '') } });
    checkpoint = 'ranking.read';
    const rankingBefore = await snapshot();
    const [rankedOwner, rankedTied, rankedZero, rankedNegative, excluded] = await Promise.all([owner, tied, buyer, other, empty].map(user => service.state(user.id)));
    assert.equal(rankedOwner.enabled, false); // Ranking never enables financial admission.
    assert.equal(rankedOwner.summary.ranking.status, 'available');
    assert.equal(rankedOwner.summary.ranking.policyRevisionId, draft.id);
    assert.equal(rankedOwner.summary.ranking.value, rankedTied.summary.ranking.value);
    assert.ok(rankedZero.summary.ranking.value > rankedOwner.summary.ranking.value);
    assert.ok(rankedNegative.summary.ranking.value > rankedZero.summary.ranking.value);
    assert.equal(excluded.summary.ranking.status, 'not_participating');
    assert.equal(excluded.summary.ranking.value, null);
    for (const state of [rankedOwner, rankedTied, rankedZero, rankedNegative]) {
      assert.equal(state.summary.ranking.complete, true);
      assert.equal(state.summary.ranking.asOf, state.summary.asOf);
      assert.equal(state.summary.ranking.endsBefore, state.summary.asOf);
      assert.equal(state.summary.ranking.timeZone, 'UTC');
      for (const privateValue of [owner.id, other.id, tied.id, owner.email, other.email])
        assert.ok(!JSON.stringify(state.summary.ranking).includes(privateValue));
    }
    assert.deepEqual(await snapshot(), rankingBefore);
    checkpoint = 'ranking.permissions';
    const instructorRole = await db.role.upsert({ where: { name: 'instructor' }, create: { name: 'instructor' }, update: {} });
    await db.userRole.create({ data: { userId: empty.id, roleId: instructorRole.id } });
    assert.equal((await service.state(empty.id)).summary.ranking.status, 'available');
    await db.userRole.delete({ where: { userId_roleId: { userId: empty.id, roleId: instructorRole.id } } });
    assert.equal((await service.state(empty.id)).summary.ranking.status, 'not_participating');
    await db.user.update({ where: { id: buyer.id }, data: { status: 'suspended' } });
    assert.equal((await service.state(buyer.id)).summary.ranking.status, 'not_participating');
    await db.user.update({ where: { id: buyer.id }, data: { status: 'active', deletedAt: new Date() } });
    assert.equal((await service.state(buyer.id)).summary.ranking.status, 'not_participating');
    await db.user.update({ where: { id: buyer.id }, data: { deletedAt: null } });
    await db.affiliateIdentity.update({ where: { id: zeroIdentity.id }, data: { status: 'suspended' } });
    assert.equal((await service.state(buyer.id)).summary.ranking.status, 'not_participating');
    // Keep excluded instructor fixture present, proving its existence grants no role.
    assert.ok(instructorIdentity.id);

    // Separate native source fixture: full canonical payment chain, with every
    // database transition/total/source guard retained. This is stored synthetic
    // evidence, not a call to or certification of a real payment provider.
    checkpoint = 'paid.fixture';
    const paidOwner = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic paid dashboard owner' } });
    const paidIdentity = await db.affiliateIdentity.create({ data: { ownerId: paidOwner.id, kind: 'general', code: randomUUID().replaceAll('-', '').slice(0, 30) } });
    const paidVisit = await db.affiliateVisit.create({ data: { identityId: paidIdentity.id, policyRevisionId: revision.id,
      tokenHash: digest(randomUUID()), expiresAt: new Date(Date.now() + 86400000) } });
    const paid = await db.$transaction(async tx => {
      const order = await tx.commerceOrder.create({ data: { buyerId: buyer.id, orderNumber: 'dashboard-paid-' + randomUUID().slice(0, 20),
        subtotalAmountMinor: 1000000n, payableAmountMinor: 1000000n, pricingPolicyVersion: 'synthetic-read-model' } });
      const line = await tx.commerceOrderLine.create({ data: { orderId: order.id, productId: product.id, productType: 'course',
        productReferenceId: course.id, sellerId: owner.id, displayTitle: course.title, currency: 'VND',
        unitListPriceAmountMinor: 1000000n, subtotalAmountMinor: 1000000n, discountAmountMinor: 0n, finalAmountMinor: 1000000n } });
      await tx.affiliateAttribution.create({ data: { identityId: paidIdentity.id, visitId: paidVisit.id,
        buyerId: buyer.id, orderId: order.id, policyRevisionId: revision.id } });
      checkpoint = 'paid.attempt';
      const attempt = await tx.commercePaymentAttempt.create({ data: { orderId: order.id, provider: 'payos',
        localRequestIdentity: randomUUID(), providerPaymentIdentity: 'synthetic-' + randomUUID(),
        providerOrderCode: BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 12)),
        providerExpiresAt: new Date(Date.now() + 3600000), providerRequestStartedAt: new Date(),
        providerReceivingAccountHash: digest('synthetic-dashboard-receiving-account'),
        amountMinor: 1000000n, currency: 'VND' } });
      const pendingOperation = randomUUID();
      checkpoint = 'paid.pending';
      await tx.commercePaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'pending', statusOperationId: pendingOperation } });
      await tx.commerceLifecycleEvent.create({ data: { entityType: 'payment', entityId: attempt.id,
        previousStatus: 'created', nextStatus: 'pending', actorKind: 'user', actorId: buyer.id,
        operationId: pendingOperation, reasonCode: 'SYNTHETIC_PROVIDER_PENDING' } });
      const settledAt = new Date(), reference = 'synthetic-' + randomUUID();
      checkpoint = 'paid.event';
      const event = await tx.commercePaymentEvent.create({ data: { paymentAttemptId: attempt.id, provider: 'payos',
        providerEventIdentity: 'synthetic-' + randomUUID(), providerPaymentIdentity: attempt.providerPaymentIdentity,
        providerSettlementReference: reference, amountMinor: 1000000n, currency: 'VND', nextStatus: 'paid', providerOccurredAt: settledAt } });
      checkpoint = 'paid.settlement';
      const settlement = await tx.commerceSettlement.create({ data: { orderId: order.id, paymentAttemptId: attempt.id, paymentEventId: event.id,
        kind: 'provider_collection', disposition: 'matched', provider: 'payos', providerSettlementReference: reference,
        amountMinor: 1000000n, currency: 'VND', settledAt } });
      const paidOperation = randomUUID();
      await tx.commercePaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'paid', statusOperationId: paidOperation, paidAt: settledAt } });
      await tx.commerceLifecycleEvent.create({ data: { entityType: 'payment', entityId: attempt.id,
        previousStatus: 'pending', nextStatus: 'paid', actorKind: 'user', actorId: buyer.id,
        operationId: paidOperation, reasonCode: 'SYNTHETIC_PROVIDER_PAID' } });
      const orderOperation = randomUUID();
      await tx.commerceOrder.update({ where: { id: order.id }, data: { status: 'confirmed', confirmedSettlementId: settlement.id,
        confirmedAt: settledAt, statusOperationId: orderOperation } });
      await tx.commerceLifecycleEvent.create({ data: { entityType: 'order', entityId: order.id,
        previousStatus: 'pending_payment', nextStatus: 'confirmed', actorKind: 'user', actorId: buyer.id,
        operationId: orderOperation, reasonCode: 'SYNTHETIC_PROVIDER_CONFIRMED' } });
      return { orderId: order.id, lineId: line.id, settlementId: settlement.id, attemptId: attempt.id };
    });
    const audit = new AuditService(db), access = new CourseAccessService(db, config);
    const fulfillment = new CommerceFulfillmentService(db, access, audit, { createForUser: async () => {} });
    checkpoint = 'paid.fulfill';
    await fulfillment.fulfillConfirmedPayment(paid.orderId, paid.settlementId, 'user', buyer.id);
    assert.equal((await db.commerceOrder.findUniqueOrThrow({ where: { id: paid.orderId } })).fulfillmentStatus, 'fulfilled');
    const paidSnapshot = async () => {
      const refunds = await db.commerceRefund.findMany({ where: { orderId: paid.orderId }, include: { allocations: true }, orderBy: { id: 'asc' } });
      return {
        state: await snapshot(),
        paidIdentity: await db.affiliateIdentity.findUnique({ where: { id: paidIdentity.id } }),
        paidVisit: await db.affiliateVisit.findUnique({ where: { id: paidVisit.id } }),
        paidAttributions: await db.affiliateAttribution.findMany({ where: { identityId: paidIdentity.id }, orderBy: { id: 'asc' } }),
        paidAccruals: await db.affiliateAccrual.findMany({ where: { attribution: { identityId: paidIdentity.id } }, orderBy: { id: 'asc' } }),
        settlements: await db.commerceSettlement.findMany({ where: { orderId: paid.orderId } }),
        attempts: await db.commercePaymentAttempt.findMany({ where: { orderId: paid.orderId } }),
        events: await db.commercePaymentEvent.findMany({ where: { paymentAttemptId: paid.attemptId } }), refunds,
        grants: await db.courseAccessGrant.findMany({ where: { userId: buyer.id }, orderBy: { id: 'asc' } }),
        lifecycle: await db.commerceLifecycleEvent.findMany({ where: { entityId: { in: [paid.orderId, paid.attemptId, ...refunds.map(refund => refund.id)] } }, orderBy: { id: 'asc' } }),
        journalCount: await db.gdsInternalJournal.count({ where: { orderRef: paid.orderId } }),
        paidWallet: await db.gdsInternalWallet.findUnique({ where: { buyerId: paidOwner.id } }),
        buyerWallet: await db.gdsInternalWallet.findUnique({ where: { buyerId: buyer.id } }),
        paidAudits: await db.auditLog.findMany({ where: { actorId: paidOwner.id }, orderBy: { id: 'asc' } }),
      };
    };
    checkpoint = 'paid.read';
    const paidBefore = await paidSnapshot();
    const paidState = await service.state(paidOwner.id);
    assert.equal(paidState.totalReferrals, 1); assert.equal(paidState.accruedAmountMinor, '0');
    assert.equal(paidState.summary.revenue.status, 'available'); assert.equal(paidState.summary.revenue.amountMinor, '1000000');
    assert.deepEqual(await paidSnapshot(), paidBefore);
    checkpoint = 'paid.refund';
    const refunds = new PaymentRefundService(db, { ...config, commerce: { idempotencySecret: 'synthetic-dashboard-refund-fixture-only' } }, audit, access);
    const requested = await refunds.create(owner.id, randomUUID(), { settlementId: paid.settlementId, amountMinor: '250000',
      reasonCode: 'SYNTHETIC_PARTIAL_REFUND', allocations: [{ orderLineId: paid.lineId, amountMinor: '250000' }] });
    await refunds.record(owner.id, requested.id, { confirmExternalAction: true, externalReference: 'synthetic-refund-' + randomUUID(),
      expectedUpdatedAt: requested.updatedAt.toISOString() });
    checkpoint = 'paid.refunded.read';
    const refundedBefore = await paidSnapshot();
    assert.deepEqual(refundedBefore.grants, paidBefore.grants); // Real partial-refund service preserves purchased access.
    for (let repeat = 0; repeat < 2; repeat++) {
      const state = await service.state(paidOwner.id);
      assert.equal(state.summary.revenue.status, 'available'); assert.equal(state.summary.revenue.amountMinor, '750000');
      assert.equal(state.summary.lifetimeCommissionMinor, '0');
    }
    assert.equal((await service.state(other.id)).summary.revenue.amountMinor, '0');
    assert.equal(refundedBefore.journalCount, 0);
    assert.deepEqual(await paidSnapshot(), refundedBefore);
    process.stdout.write('AFFILIATE_DASHBOARD_PRISMA=PASS signed_owner_aggregates disabled_policy versioned_ranking competition_ties historical_sources role_boundaries future_policy real_qr canonical_net_revenue partial_refund immutable_reads\n');
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(value) ? value : 'UNAVAILABLE';
  const cause = error?.meta?.driverAdapterError?.cause;
  process.stderr.write(`AFFILIATE_DASHBOARD_PRISMA=FAIL ${identifier(error?.name)} stage=${checkpoint} code=${identifier(error?.code)} model=${identifier(error?.meta?.modelName)} pg=${identifier(cause?.originalCode)}\n`);
  process.exitCode = 1;
});
