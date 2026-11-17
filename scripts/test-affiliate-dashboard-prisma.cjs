'use strict';
// Read-model acceptance only: synthetic historical accruals (including refund corrections),
// NOT evidence that these pending orders earn commission. No reconciliation/provider/wallet posting.
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
  const QRCode = require('qrcode');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const digest = text => createHash('sha256').update(text).digest('hex');
  try {
    checkpoint = 'fixture.users';
    const [owner, other, empty, buyer] = await Promise.all(['owner', 'other', 'empty', 'buyer'].map(label => db.user.create({
      data: { email: `${randomUUID()}@synthetic.invalid`, fullName: `Synthetic dashboard ${label}` },
    })));
    checkpoint = 'fixture.policy';
    const version = (await db.platformPolicyRevision.aggregate({ where: { group: 'affiliate' }, _max: { version: true } }))._max.version ?? 0;
    const revision = await db.platformPolicyRevision.create({ data: { group: 'affiliate', version: version + 1,
      status: 'scheduled', createdById: owner.id, approvedById: owner.id, approvedAt: new Date(), effectiveAt: new Date(),
      content: { ...DEFAULT_PLATFORM_SETTINGS.affiliate, enabled: false },
    } });
    checkpoint = 'fixture.identities';
    const identities = await Promise.all([[owner, 'general'], [owner, 'instructor'], [other, 'general']].map(([user, kind]) =>
      db.affiliateIdentity.create({ data: { ownerId: user.id, kind, code: randomUUID().replaceAll('-', '').slice(0, 30) } })));
    checkpoint = 'fixture.product';
    const course = await db.course.create({ data: { title: 'Synthetic dashboard course', slug: randomUUID(),
      instructorId: owner.id, level: 'beginner', status: 'published', visibility: 'public', priceAmountMinor: 1000000, priceCurrency: 'VND' } });
    const product = await db.commerceProduct.create({ data: { type: 'course', courseId: course.id, sellerId: owner.id, status: 'draft' } });
    await db.commerceProduct.update({ where: { id: product.id }, data: { status: 'active' } });
    // Owner: 120000 - 45000 + 5000 = 80000; other: 7000 - 12000 = -5000.
    // A no-accrual attribution still counts; neither visits nor accrual rows are referral counts.
    for (const [index, deltas] of [[0, [120000n, -45000n]], [1, [5000n]], [0, []], [2, [7000n, -12000n]]]) {
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
      const ownerIds = [owner.id, other.id, empty.id];
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
    process.stdout.write('AFFILIATE_DASHBOARD_PRISMA=PASS signed_owner_aggregates disabled_policy real_qr immutable_reads\n');
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(value) ? value : 'UNAVAILABLE';
  const cause = error?.meta?.driverAdapterError?.cause;
  process.stderr.write(`AFFILIATE_DASHBOARD_PRISMA=FAIL ${identifier(error?.name)} stage=${checkpoint} code=${identifier(error?.code)} model=${identifier(error?.meta?.modelName)} pg=${identifier(cause?.originalCode)}\n`);
  process.exitCode = 1;
});
