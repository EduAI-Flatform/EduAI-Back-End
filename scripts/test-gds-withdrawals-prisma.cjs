'use strict';
// Disposable CI PostgreSQL only; never loads .env or calls a payment provider.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true', 'CI disposable database required');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { CourseAccessService } = require('../dist/src/modules/access/course-access.service.js');
  const { CommerceService } = require('../dist/src/modules/commerce/commerce.service.js');
  const { CommerceOrderService } = require('../dist/src/modules/commerce/commerce-order.service.js');
  const { RevenueFinanceService } = require('../dist/src/modules/revenue-sharing/revenue-finance.service.js');
  const { GdsRevenueWalletService } = require('../dist/src/modules/wallet/gds-revenue-wallet.service.js');
  const { AffiliateWalletService } = require('../dist/src/modules/wallet/affiliate-wallet.service.js');
  const { GdsWithdrawalService } = require('../dist/src/modules/wallet/gds-withdrawal.service.js');
  const { GdsWalletService } = require('../dist/src/modules/wallet/gds-wallet.service.js');
  const { GdsAccountVerificationService } = require('../dist/src/modules/wallet/gds-account-verification.service.js');
  const { buildRuntimeGdsPrivilegeStatement, buildRuntimeGdsWithdrawalPrivilegeStatement, buildRuntimeGdsVerificationPrivilegeStatement,
    PLATFORM_RUNTIME_TABLES, PLATFORM_RUNTIME_SCHEMA_QUERY, buildRuntimePlatformPrivilegeStatement } = require('./membership-runtime-privileges.cjs');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const config = { app: { nodeEnv: 'test', deploymentClass: 'uat' }, gdsWallet: { sandboxEnabled: true } };
  const finance = new RevenueFinanceService(db);
  const revenue = new GdsRevenueWalletService(db, config, finance, new AffiliateWalletService(finance));
  const manualAccounts = new GdsAccountVerificationService(db,
    { async get(code) { assert.ok(['MB', '970422'].includes(code)); return { code: 'MB', bin: '970422', name: 'Synthetic CI Bank', shortName: 'MB', lookupSupported: false }; } },
    { isAvailable: () => false, available: () => false, async lookup() { throw new Error('Manual check must never call provider'); } });
  const service = new GdsWithdrawalService(db, config, revenue, manualAccounts);
  const input = { amountMinor: '150000', bankCode: 'MB', accountNumber: '123456789', accountHolder: 'SYNTHETIC TEST ONLY' };
  const admin = randomUUID(), otherAdmin = randomUUID();
  async function user(opening = 200000n) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${id}@synthetic.invalid`, fullName: 'Synthetic GDS withdrawal' } });
    // Owner-only opening fixtures, confined to the guarded disposable DB above.
    const wallet = await db.gdsInternalWallet.create({ data: { buyerId: id, availableMinor: opening } });
    return { id, wallet };
  }
  async function settle(promise) { return Promise.allSettled(promise); }
  const balance = id => db.gdsInternalWallet.findUniqueOrThrow({ where: { buyerId: id } });
  try {
    await db.user.createMany({ data: [admin, otherAdmin].map(id => ({ id, email: `${id}@synthetic.invalid`, fullName: 'Synthetic GDS operator' })) });
    await db.gdsWithdrawalSettings.update({ where: { id: 'global' }, data: { minimumMinor: 50000n, maximumMinor: 10000000n, admissionEnabled: true, processingEnabled: true } });

    // Commit a withdrawal after the wallet is read but before its hold totals.
    // Repeatable-read must return one coherent pre-write snapshot, then refresh.
    const reportingOwner = await user();
    let concurrentRequest;
    const snapshotClient = {
      $transaction: (read, options) => db.$transaction(async tx => read(new Proxy(tx, {
        get(target, key) {
          if (key !== 'gdsInternalWallet') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
          return new Proxy(target.gdsInternalWallet, { get(model, operation) {
            if (operation !== 'findUnique') return typeof model[operation] === 'function' ? model[operation].bind(model) : model[operation];
            return async query => {
              const row = await model.findUnique(query);
              concurrentRequest = await service.create(reportingOwner.id, { ...input, amountMinor: '50000' }, randomUUID());
              return row;
            };
          } });
        },
      })), options),
    };
    const beforeWithdrawal = await new GdsWalletService(snapshotClient, config, service).summary(reportingOwner.id);
    assert.equal(beforeWithdrawal.available, true);
    assert.equal(beforeWithdrawal.balance.availableMinor, '200000');
    assert.equal(beforeWithdrawal.withdrawalHeldMinor, '0');
    const afterWithdrawal = await new GdsWalletService(db, config, service).summary(reportingOwner.id);
    assert.equal(afterWithdrawal.balance.availableMinor, '150000');
    assert.equal(afterWithdrawal.withdrawalHeldMinor, '50000');
    assert.equal(afterWithdrawal.paymentHeldMinor, '0');
    assert.equal(afterWithdrawal.totalWithdrawnMinor, '0');
    await service.act(reportingOwner.id, concurrentRequest.id, 'cancel', { reason: 'Synthetic reporting cleanup' }, true);
    console.log('GDS_WALLET_REPORTING_REPEATABLE_SNAPSHOT=PASS');

    const a = await user();
    const raced = await settle([service.create(a.id, input, randomUUID()), service.create(a.id, input, randomUUID())]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(a.id)).availableMinor, 50000n);
    assert.equal((await balance(a.id)).heldMinor, 150000n);
    console.log('GDS_CONCURRENT_WITHDRAWALS=PASS');

    const b = await user();
    const sameKey = randomUUID();
    const duplicates = await Promise.all([service.create(b.id, input, sameKey), service.create(b.id, input, sameKey)]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    assert.equal(await db.gdsWithdrawal.count({ where: { ownerId: b.id } }), 1);
    assert.equal((await balance(b.id)).heldMinor, 150000n);
    console.log('GDS_IDEMPOTENCY_RACE=PASS');

    const c = await user();
    const orderRef = `ci:competing-checkout:${randomUUID()}`;
    const spendRace = await settle([
      service.create(c.id, input, randomUUID()),
      db.gdsInternalJournal.create({ data: { walletId: c.wallet.id, eventKey: `ci:reserve:${randomUUID()}`, kind: 'RESERVE', amountMinor: 150000n,
        availableDeltaMinor: -150000n, heldDeltaMinor: 150000n, clearingDeltaMinor: 0n, orderRef } }),
    ]);
    assert.equal(spendRace.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(c.id)).availableMinor, 50000n);
    assert.equal((await balance(c.id)).heldMinor, 150000n);
    console.log('GDS_WITHDRAWAL_VS_CHECKOUT_RESERVE=PASS');

    const d = await user();
    const request = await service.create(d.id, input, randomUUID());
    const stateRace = await settle([
      service.act(d.id, request.id, 'cancel', { reason: 'Synthetic owner cancellation' }, true),
      service.act(admin, request.id, 'approve', { reason: 'Synthetic admin approval' }),
    ]);
    assert.equal(stateRace.filter(r => r.status === 'fulfilled').length, 1);
    const state = await db.gdsWithdrawal.findUniqueOrThrow({ where: { id: request.id } });
    if (state.status === 'APPROVED') await service.act(admin, request.id, 'reject', { reason: 'Synthetic cleanup before transfer' });
    assert.equal((await balance(d.id)).availableMinor, 200000n);
    assert.equal((await balance(d.id)).heldMinor, 0n);
    console.log('GDS_CANCEL_VS_APPROVE=PASS');

    const e = await user();
    const payable = await service.create(e.id, input, randomUUID());
    await assert.rejects(service.confirmRecipient(admin, payable.id, { confirmed: true, accountHolder: 'WRONG NAME', reason: 'Synthetic mismatch' }), /GDS_ACCOUNT_HOLDER_MISMATCH/);
    assert.equal(await db.gdsAccountVerification.count({ where: { withdrawalId: payable.id } }), 0);
    const claims = await settle([service.confirmRecipient(admin, payable.id, { confirmed: true }), service.confirmRecipient(otherAdmin, payable.id, { confirmed: true })]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    const claimed = await db.gdsWithdrawal.findUniqueOrThrow({ where: { id: payable.id } });
    assert.equal(claimed.status, 'PROCESSING');
    assert.equal(await db.gdsWithdrawalEvent.count({ where: { withdrawalId: payable.id, toStatus: 'APPROVED' } }), 1);
    assert.equal(await db.gdsWithdrawalEvent.count({ where: { withdrawalId: payable.id, toStatus: 'PROCESSING' } }), 1);
    await service.confirmRecipient(claimed.processingAdminId, payable.id, { confirmed: true });
    assert.equal(await db.gdsWithdrawalEvent.count({ where: { withdrawalId: payable.id, toStatus: 'PROCESSING' } }), 1);
    const manualQr = await manualAccounts.qr(claimed.processingAdminId, payable.id);
    assert.equal(manualQr.verificationMethod, 'MANUAL');
    assert.equal(manualQr.accountNumber, input.accountNumber);
    assert.equal(manualQr.amountMinor, input.amountMinor);
    await assert.rejects(manualAccounts.qr(claimed.processingAdminId === admin ? otherAdmin : admin, payable.id), /GDS_WITHDRAWAL_QR_NOT_ALLOWED/);
    const proof = { bankTransactionRef: `ci:${randomUUID()}`, transferredAt: new Date().toISOString() };
    await assert.rejects(service.act(e.id, payable.id, 'cancel', { reason: 'Too late' }, true));
    const pays = await settle([service.act(claimed.processingAdminId, payable.id, 'pay', proof), service.act(claimed.processingAdminId, payable.id, 'pay', proof)]);
    assert.equal(pays.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await balance(e.id)).availableMinor, 50000n);
    assert.equal((await balance(e.id)).heldMinor, 0n);
    assert.equal(await db.gdsInternalJournal.count({ where: { orderRef: payable.id, kind: 'WITHDRAWAL_PAID' } }), 1);
    assert.equal((await db.gdsWithdrawalEvent.findFirstOrThrow({ where: { withdrawalId: payable.id, toStatus: 'PAID' } })).reason, 'Admin xác nhận đã chuyển khoản.');
    console.log('GDS_TRANSFER_CLAIM_AND_PAID_RACE=PASS');

    // Exercise real Prisma calls under the bounded production-style role.
    const role = `gds_withdraw_${randomUUID().replaceAll('-', '')}`;
    await db.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const statement of [buildRuntimeGdsPrivilegeStatement(`postgresql://${role}@localhost/test`), buildRuntimeGdsWithdrawalPrivilegeStatement(`postgresql://${role}@localhost/test`),
      buildRuntimeGdsVerificationPrivilegeStatement(`postgresql://${role}@localhost/test`)].join(';').split(';').filter(x => x.trim())) {
      await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe(`GRANT SELECT ON revenue_earning_periods, revenue_ledger_entries TO "${role}"`);
    // This disposable role exercises the empty affiliate-owner query. Every included relation needs SELECT.
    await db.$executeRawUnsafe(`GRANT SELECT ON affiliate_attributions, affiliate_identities, platform_policy_revisions, affiliate_accruals, commerce_orders, commerce_settlements, commerce_refunds TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT(migration_name,checksum,finished_at,rolled_back_at) ON _prisma_migrations TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON audit_logs TO "${role}"`);
    const applicationTables = await db.$queryRawUnsafe(PLATFORM_RUNTIME_SCHEMA_QUERY, 'public', PLATFORM_RUNTIME_TABLES);
    assert.equal(applicationTables.length, 9, 'All additive application tables must exist in the disposable replay');
    for (const statement of buildRuntimePlatformPrivilegeStatement(`postgresql://${role}@localhost/test`, applicationTables).split(';').filter(value => value.trim())) {
      await db.$executeRawUnsafe(statement);
    }
    const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` }) });
    try {
      // Real Prisma persistence under the bounded role covers private application
      // tables, including native upsert behavior and encrypted MFA-state reads.
      const applicationOwner = await user(0n);
      const applicationBuyer = await user(0n);
      // Canonical synthetic top-up proof/journal, inside this guarded disposable
      // database only. Qualification must work with the actual restricted role.
      const topupId = randomUUID(), inboxId = randomUUID();
      const collection = `card-proof-${topupId}`, paymentLink = `card-link-${topupId}`;
      const qrHash = 'a'.repeat(64), bankHash = 'b'.repeat(64);
      const signedAt = new Date(Date.now() - 1000), topupOrderCode = BigInt(Date.now());
      await db.$transaction(async tx => {
        await tx.gdsInternalTopup.create({ data: {
          id: topupId, buyerId: applicationOwner.id, walletId: applicationOwner.wallet.id,
          requestKeyHash: qrHash, amountMinor: 85000n, payosOrderCode: topupOrderCode,
          transferMemo: 'G00000001', receivingAccountHash: qrHash, paymentLinkId: paymentLink,
          status: 'PENDING_PAYOS', createdAt: new Date(signedAt.getTime() - 1000), expiresAt: new Date(Date.now() + 3600000),
        } });
        await tx.gdsInternalPayosInbox.create({ data: {
          id: inboxId, topupId, providerEventIdentity: collection, payosOrderCode: topupOrderCode,
          paymentLinkId: paymentLink, amountMinor: 85000n, currency: 'VND', receivingAccount: 'SYNTHETIC',
          receivingAccountHash: bankHash, occurredAt: signedAt, signatureVerifiedAt: signedAt,
        } });
        await tx.gdsInternalPayosReconciliation.create({ data: {
          topupId, inboxId, providerEventIdentity: collection, payosOrderCode: topupOrderCode,
          paymentLinkId: paymentLink, amountMinor: 85000n, currency: 'VND',
          qrReceivingAccountHash: qrHash, settlementReceivingAccountHash: bankHash,
          occurredAt: signedAt, signatureVerifiedAt: signedAt, providerReconciledAt: signedAt,
        } });
        await tx.gdsInternalTopup.update({ where: { id: topupId }, data: {
          status: 'PAYOS_VERIFIED', collectionReference: collection, settlementReceivingAccountHash: bankHash,
          signatureVerifiedAt: signedAt, providerReconciledAt: signedAt,
        } });
        await tx.gdsInternalJournal.create({ data: {
          walletId: applicationOwner.wallet.id, eventKey: `card-credit-${topupId}`, kind: 'TOPUP_CREDIT',
          amountMinor: 85000n, availableDeltaMinor: 85000n, heldDeltaMinor: 0n, clearingDeltaMinor: -85000n,
          topupId, collectionReference: collection,
        } });
      });
      const { computeMembershipCardForUser } = require('../dist/src/modules/membership-cards/membership-card-source.js');
      const cardPolicy = { enabled: true, basis: 'topup', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
        tiers: [{ code: 'member', name: { vi: 'Member', en: 'Member' }, threshold: 0, benefits: [] },
          { code: 'gold', name: { vi: 'Gold', en: 'Gold' }, threshold: 85000, benefits: [] }] };
      const balanceBeforeCard = await balance(applicationOwner.id);
      const topupCard = await runtime.$transaction(tx => computeMembershipCardForUser(tx, cardPolicy, 'synthetic-policy', applicationOwner.id), { isolationLevel: 'RepeatableRead' });
      assert.equal(topupCard.status, 'evaluated');
      assert.equal(topupCard.qualifyingAmountMinor, '85000');
      assert.equal(topupCard.tier.code, 'gold');
      assert.equal(topupCard.eligibleTopupCount, 1);
      assert.equal((await computeMembershipCardForUser(runtime, cardPolicy, 'synthetic-policy', applicationBuyer.id)).qualifyingAmountMinor, '0');
      assert.deepEqual(await balance(applicationOwner.id), balanceBeforeCard, 'Card evaluation must never mutate wallet state');
      console.log('GDS_MEMBERSHIP_TOPUP_RESTRICTED_SOURCE=PASS');
      // Use canonical checkout services for draft-to-active product lifecycle,
      // cart conversion, immutable line snapshots and matching order totals.
      // This pending synthetic order is only an attribution FK, never paid.
      const courseId = randomUUID();
      await db.course.create({ data: {
        id: courseId, instructorId: applicationOwner.id, title: 'Synthetic runtime permission course',
        slug: 'gds-runtime-' + courseId, level: 'beginner', status: 'published',
        visibility: 'public', priceAmountMinor: 10000, priceCurrency: 'VND',
      } });
      const checkoutConfig = { ...config, commerce: { idempotencySecret: 'synthetic-runtime-checkout-ci-only-32-chars' } };
      const checkoutAudit = new AuditService(db);
      const checkoutAccess = new CourseAccessService(db, checkoutConfig);
      const checkoutCart = new CommerceService(db, checkoutAudit, checkoutAccess);
      const checkoutOrders = new CommerceOrderService(db, checkoutConfig, {}, checkoutAudit, checkoutAccess);
      await checkoutCart.addCourse(applicationBuyer.id, courseId);
      const applicationOrder = await checkoutOrders.createOrder(applicationBuyer.id, randomUUID(), {});
      const persistedApplicationOrder = await db.commerceOrder.findUniqueOrThrow({
        where: { id: applicationOrder.id }, include: { lines: true },
      });
      assert.equal(persistedApplicationOrder.status, 'pending_payment');
      assert.equal(persistedApplicationOrder.lines.length, 1);
      assert.equal(persistedApplicationOrder.payableAmountMinor, 10000n);
      assert.equal(persistedApplicationOrder.lines[0].finalAmountMinor, 10000n);
      const lastApplicationPolicy = await db.platformPolicyRevision.aggregate({ where: { group: 'branding' }, _max: { version: true } });
      const applicationPolicy = await runtime.platformPolicyRevision.create({ data: {
        group: 'branding', version: (lastApplicationPolicy._max.version ?? 0) + 1,
        content: {}, createdById: applicationOwner.id,
      } });
      await runtime.platformPolicyRevision.update({ where: { id: applicationPolicy.id }, data: {
        status: 'approved', approvedById: applicationOwner.id, approvedAt: new Date(),
      } });
      await runtime.platformPolicyRevision.update({ where: { id: applicationPolicy.id }, data: { status: 'scheduled', effectiveAt: new Date() } });
      const applicationTicket = await runtime.platformSupportTicket.create({ data: {
        ownerId: applicationOwner.id, title: 'Synthetic runtime support', content: 'Synthetic content',
        attachmentData: Buffer.from('synthetic-image-bytes'), attachmentSize: 21,
      } });
      await runtime.platformSupportTicket.update({ where: { id: applicationTicket.id }, data: { status: 'in_progress' } });
      const applicationReply = await runtime.platformSupportReply.create({ data: {
        ticketId: applicationTicket.id, authorId: applicationOwner.id, content: 'Synthetic reply',
      } });
      const applicationPartner = await runtime.platformPartnerApplication.create({ data: {
        category: 'school', name: 'Synthetic', organization: 'Synthetic school', phone: '0000000000',
        email: 'runtime@synthetic.invalid', content: 'Synthetic request', consentAt: new Date(),
      } });
      await runtime.platformPartnerApplication.update({ where: { id: applicationPartner.id }, data: { status: 'reviewing' } });
      await runtime.userMfa.upsert({ where: { userId: applicationOwner.id }, create: { userId: applicationOwner.id }, update: {} });
      await runtime.userMfa.upsert({ where: { userId: applicationOwner.id }, create: { userId: applicationOwner.id }, update: {} });
      await runtime.userMfa.update({ where: { userId: applicationOwner.id }, data: {
        enabled: true, revision: 1, secretEncrypted: 'synthetic-encrypted-state', enabledAt: new Date(),
        pendingSecretEncrypted: null, pendingExpiresAt: null, lastUsedStep: 1, recoveryCodeHashes: ['synthetic-hash'],
      } });
      assert.equal((await runtime.userMfa.findUniqueOrThrow({ where: { userId: applicationOwner.id } })).secretEncrypted, 'synthetic-encrypted-state');
      const identityArguments = {
        where: { ownerId_kind: { ownerId: applicationOwner.id, kind: 'general' } },
        create: { ownerId: applicationOwner.id, kind: 'general', code: randomUUID().replaceAll('-', '') }, update: {},
      };
      const applicationIdentity = await runtime.affiliateIdentity.upsert(identityArguments);
      assert.equal((await runtime.affiliateIdentity.upsert(identityArguments)).id, applicationIdentity.id);
      const applicationVisit = await runtime.affiliateVisit.create({ data: {
        tokenHash: randomUUID().replaceAll('-', '').repeat(2), identityId: applicationIdentity.id,
        policyRevisionId: applicationPolicy.id, expiresAt: new Date(Date.now() + 86400000),
      } });
      const applicationAttribution = await runtime.affiliateAttribution.create({ data: {
        orderId: applicationOrder.id, identityId: applicationIdentity.id, buyerId: applicationBuyer.id,
        visitId: applicationVisit.id, policyRevisionId: applicationPolicy.id,
      } });
      const applicationAccrual = await runtime.affiliateAccrual.create({ data: {
        attributionId: applicationAttribution.id, sourceDigest: randomUUID(), deltaMinor: 0n,
        qualifyingAmountMinor: 0n, commissionBps: 0, currency: 'VND', holdUntil: new Date(),
      } });
      for (const model of ['platformPolicyRevision', 'platformSupportTicket', 'platformSupportReply', 'platformPartnerApplication', 'userMfa',
        'affiliateIdentity', 'affiliateVisit', 'affiliateAttribution', 'affiliateAccrual']) assert.ok(await runtime[model].count() >= 1);
      await assert.rejects(runtime.platformPolicyRevision.update({ where: { id: applicationPolicy.id }, data: { content: { forged: true } } }), /permission denied/);
      await assert.rejects(runtime.platformSupportTicket.update({ where: { id: applicationTicket.id }, data: { content: 'forged' } }), /permission denied/);
      await assert.rejects(runtime.platformPartnerApplication.update({ where: { id: applicationPartner.id }, data: { email: 'forged@synthetic.invalid' } }), /permission denied/);
      await assert.rejects(runtime.userMfa.update({ where: { userId: applicationOwner.id }, data: { userId: applicationBuyer.id } }), /permission denied/);
      await assert.rejects(runtime.userMfa.delete({ where: { userId: applicationOwner.id } }), /permission denied/);
      await assert.rejects(runtime.platformSupportReply.update({ where: { id: applicationReply.id }, data: { content: 'forged' } }), /permission denied/);
      await assert.rejects(runtime.affiliateIdentity.update({ where: { id: applicationIdentity.id }, data: { code: 'forged' } }), /permission denied/);
      await assert.rejects(runtime.affiliateVisit.update({ where: { id: applicationVisit.id }, data: { tokenHash: 'forged' } }), /permission denied/);
      await assert.rejects(runtime.affiliateAttribution.update({ where: { id: applicationAttribution.id }, data: { buyerId: applicationOwner.id } }), /permission denied/);
      await assert.rejects(runtime.affiliateAccrual.update({ where: { id: applicationAccrual.id }, data: { deltaMinor: 1n } }), /permission denied/);
      console.log('GDS_PLATFORM_RESTRICTED_RUNTIME_MATRIX=PASS');
      const { affiliateOrderSelect } = require('../dist/src/modules/affiliate/affiliate-source.js');
      assert.deepEqual(await runtime.affiliateAttribution.findMany({ where: { identity: { ownerId: randomUUID() } },
        include: { policy: true, order: { select: affiliateOrderSelect }, accruals: true } }), []);
      const runtimeFinance = new RevenueFinanceService(runtime);
      const runtimeRevenue = new GdsRevenueWalletService(runtime, config, runtimeFinance, new AffiliateWalletService(runtimeFinance));
      const runtimeService = new GdsWithdrawalService(runtime, config, runtimeRevenue);
      const f = await user();
      const created = await runtimeService.create(f.id, { ...input, amountMinor: '50000' }, randomUUID());
      const runtimeSummary = await new GdsWalletService(runtime, config, runtimeService).summary(f.id, undefined, ['student', 'instructor']);
      assert.equal(runtimeSummary.available, true);
      assert.equal(runtimeSummary.withdrawalHeldMinor, '50000');
      assert.equal(runtimeSummary.income.status, 'READY');
      assert.equal(runtimeSummary.totalDepositedMinor, '0'); // Opening fixture is not a deposit posting.
      assert.equal(runtimeSummary.totalPaidMinor, '0');
      const { readHistoryPage, parseHistoryQuery } = require('../dist/src/modules/wallet/gds-wallet-history.js');
      const activity = await readHistoryPage(runtime, f.id, parseHistoryQuery(f.id, 'withdrawals'));
      assert.equal(activity.items.length, 1);
      assert.equal(activity.items[0].withdrawalId, created.id);
      assert.equal(activity.items[0].accountNumber, '••••' + input.accountNumber.slice(-4));
      assert.equal(activity.items[0].status, 'PENDING');
      assert.equal(JSON.stringify(activity).includes(input.accountNumber), false);
      await runtimeService.act(f.id, created.id, 'cancel', { reason: 'Synthetic runtime recovery' }, true);
      assert.equal((await balance(f.id)).availableMinor, 200000n);
      await assert.rejects(runtime.gdsInternalWallet.update({ where: { id: f.wallet.id }, data: { debtMinor: 1n } }));
      await assert.rejects(runtime.gdsWithdrawal.update({ where: { id: created.id }, data: { status: 'PAID' } }));
      console.log('GDS_WITHDRAWAL_RESTRICTED_RUNTIME=PASS');

      // Synthetic lookup exists only inside this guarded disposable-CI test.
      // All persistence, restricted-role permissions, triggers and races remain real PostgreSQL.
      let lookupEnabled = true;
      let lookups = 0;
      const syntheticBank = { code: 'MB', bin: '970422', name: 'Synthetic CI Bank', shortName: 'MB', lookupSupported: true };
      const syntheticBanks = { async get(code) { assert.ok(['MB', '970422'].includes(code)); return syntheticBank; } };
      const syntheticProvider = {
        isAvailable: () => lookupEnabled,
        available: bin => lookupEnabled && bin === syntheticBank.bin,
        async lookup(bin, account) {
          assert.ok(lookupEnabled, 'Disabled synthetic provider must never be called');
          assert.equal(bin, syntheticBank.bin); assert.equal(account, input.accountNumber);
          lookups += 1;
          return { accountHolder: input.accountHolder, provider: 'vietqr', providerReference: `ci:lookup:${randomUUID()}` };
        },
      };
      const accounts = new GdsAccountVerificationService(runtime, syntheticBanks, syntheticProvider);
      const verifiedService = new GdsWithdrawalService(runtime, config, runtimeRevenue, accounts);
      await runtime.gdsWithdrawalSettings.update({ where: { id: 'global' }, data: { accountVerificationRequired: true } });
      const g = await user(500000n);
      await assert.rejects(verifiedService.create(g.id, input, randomUUID()), /GDS_ACCOUNT_VERIFICATION_REQUIRED/);
      assert.equal((await balance(g.id)).heldMinor, 0n);
      assert.equal(await db.gdsInternalJournal.count({ where: { walletId: g.wallet.id, kind: 'WITHDRAWAL_RESERVE' } }), 0);
      const verified = await accounts.verify(g.id, input.bankCode, input.accountNumber);
      const verifiedInput = { ...input, accountHolder: 'UNTRUSTED CLIENT NAME', verificationId: verified.verificationId };
      const verifiedKey = randomUUID();
      const verifiedRequest = await verifiedService.create(g.id, verifiedInput, verifiedKey);
      assert.equal(verifiedRequest.accountHolder, input.accountHolder);
      const replay = await verifiedService.create(g.id, verifiedInput, verifiedKey);
      assert.equal(replay.id, verifiedRequest.id);
      await assert.rejects(verifiedService.create(g.id, verifiedInput, randomUUID()));
      assert.equal(await db.gdsWithdrawal.count({ where: { ownerId: g.id } }), 1);
      assert.equal((await balance(g.id)).heldMinor, 150000n);
      assert.equal(await db.gdsInternalJournal.count({ where: { walletId: g.wallet.id, kind: 'WITHDRAWAL_RESERVE' } }), 1);
      console.log('GDS_VERIFIED_RUNTIME_CREATE_REPLAY_AND_PROOF_REUSE=PASS');

      // Race distinct keys against a single proof with enough money for both:
      // evidence uniqueness, rather than insufficient funds, must pick one winner.
      const h = await user(500000n);
      const shared = await accounts.verify(h.id, input.bankCode, input.accountNumber);
      const sharedInput = { ...input, verificationId: shared.verificationId };
      const proofRace = await settle([
        verifiedService.create(h.id, sharedInput, randomUUID()), verifiedService.create(h.id, sharedInput, randomUUID()),
      ]);
      assert.equal(proofRace.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await balance(h.id)).heldMinor, 150000n);
      assert.equal(await db.gdsInternalJournal.count({ where: { walletId: h.wallet.id, kind: 'WITHDRAWAL_RESERVE' } }), 1);
      console.log('GDS_VERIFIED_RUNTIME_CONCURRENT_PROOF_REUSE=PASS');

      await verifiedService.act(admin, verifiedRequest.id, 'approve', { reason: 'Synthetic verified approval' });
      await assert.rejects(accounts.qr(admin, verifiedRequest.id), /GDS_WITHDRAWAL_QR_NOT_ALLOWED/);
      const lookupsBeforeClaims = lookups;
      const verifiedClaims = await settle([
        verifiedService.act(admin, verifiedRequest.id, 'process', { reason: 'Synthetic verified claim' }),
        verifiedService.act(otherAdmin, verifiedRequest.id, 'process', { reason: 'Synthetic competing claim' }),
      ]);
      assert.equal(verifiedClaims.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(lookups > lookupsBeforeClaims, 'Transfer claim must perform a new beneficiary lookup');
      const verifiedClaimed = await db.gdsWithdrawal.findUniqueOrThrow({ where: { id: verifiedRequest.id } });
      const claimant = verifiedClaimed.processingAdminId;
      const nonClaimant = claimant === admin ? otherAdmin : admin;
      assert.ok([admin, otherAdmin].includes(claimant));
      assert.equal(await db.gdsAccountVerification.count({ where: { withdrawalId: verifiedRequest.id, purpose: 'TRANSFER', actorId: claimant } }), 1);
      await assert.rejects(accounts.qr(nonClaimant, verifiedRequest.id), /GDS_WITHDRAWAL_QR_NOT_ALLOWED/);
      const qr = await accounts.qr(claimant, verifiedRequest.id);
      assert.equal(qr.bankBin, syntheticBank.bin); assert.equal(qr.accountNumber, input.accountNumber);
      assert.equal(qr.accountHolder, input.accountHolder); assert.equal(qr.amountMinor, input.amountMinor);
      assert.equal(qr.transferContent, `GDSW${verifiedRequest.id.replaceAll('-', '').slice(0, 21).toUpperCase()}`);
      assert.ok(qr.qrCodeDataUrl.startsWith('data:image/png;base64,'));
      const png = Buffer.from(qr.qrCodeDataUrl.slice('data:image/png;base64,'.length), 'base64');
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 480);
      console.log('GDS_VERIFIED_RUNTIME_CLAIM_AND_PROTECTED_QR=PASS');

      lookupEnabled = false;
      const lookupsBeforeRecovery = lookups;
      const replayDuringOutage = await verifiedService.create(g.id, verifiedInput, verifiedKey);
      assert.equal(replayDuringOutage.id, verifiedRequest.id);
      await assert.rejects(accounts.verify(g.id, input.bankCode, input.accountNumber), /GDS_ACCOUNT_VERIFICATION_UNAVAILABLE/);
      await verifiedService.act(claimant, verifiedRequest.id, 'pay', { reason: 'Synthetic statement proves transfer despite lookup outage',
        bankTransactionRef: `ci:verified:${randomUUID()}`, transferredAt: new Date().toISOString() });
      assert.equal(lookups, lookupsBeforeRecovery);
      assert.equal((await balance(g.id)).heldMinor, 0n);
      assert.equal((await balance(g.id)).availableMinor, 350000n);
      assert.equal(await db.gdsInternalJournal.count({ where: { orderRef: verifiedRequest.id, kind: 'WITHDRAWAL_PAID' } }), 1);
      await assert.rejects(accounts.qr(claimant, verifiedRequest.id), /GDS_WITHDRAWAL_QR_NOT_ALLOWED/);
      await runtime.gdsWithdrawalSettings.update({ where: { id: 'global' }, data: { accountVerificationRequired: false } });
      console.log('GDS_VERIFIED_RUNTIME_PROVIDER_OUTAGE_RECOVERY=PASS');

      const { configureGdsWithdrawals, parseArguments } = require('./configure-gds-withdrawals.cjs');
      const { Client } = require('pg');
      const { execFileSync } = require('node:child_process');
      class RuntimeClient extends Client { constructor(config) { super({ ...config, options: `-c role=${role}` }); } }
      const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
      const activation = await configureGdsWithdrawals(parseArguments(['--action','enable','--minimum','10000','--maximum','10000000','--expected-sha',sha,'--authorize-production-withdrawals']), {
        environment: { NODE_ENV: 'production', DEPLOYMENT_CLASS: 'production', DATABASE_URL: process.env.DATABASE_URL }, ClientConstructor: RuntimeClient,
      });
      assert.equal(activation.minimumMinor, '10000'); assert.equal(activation.admissionEnabled, true);
      console.log('GDS_WITHDRAWAL_OWNER_APPROVED_ACTIVATION=PASS');
    } finally { await runtime.$disconnect(); }
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
