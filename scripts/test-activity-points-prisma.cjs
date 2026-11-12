'use strict';
// Synthetic CI-only fixtures. Never loads .env or calls an external provider.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true', 'Disposable CI required');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const { AuditService } = require('../dist/src/common/audit/audit.service.js');
  const { ActivityPointService } = require('../dist/src/modules/tmi/activity-point.service.js');
  const { PointLedgerService } = require('../dist/src/modules/tmi/point-ledger.service.js');
  const { TmiRedemptionService } = require('../dist/src/modules/tmi/tmi-redemption.service.js');
  const { ActivityPointWorker } = require('../dist/src/modules/tmi/activity-point.worker.js');
  const { readActivityPointReadiness, POINT_SCHEMA_MIGRATION, POINT_SCHEMA_SHA256 } = require('../dist/src/modules/tmi/activity-point.readiness.js');
  const { REVIEWED_POINT_MIGRATIONS } = require('./run-production-migrations.cjs');
  assert.deepEqual(REVIEWED_POINT_MIGRATIONS, [{ name: POINT_SCHEMA_MIGRATION, sha256: POINT_SCHEMA_SHA256 }]);
  const { buildRuntimePointPrivilegeStatement } = require('./membership-runtime-privileges.cjs');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const role = `point_${randomUUID().replaceAll('-', '')}`;
  let runtime;
  try {
    const admin = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic point operator' } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic point learner' } });
    const course = await db.course.create({ data: { title: 'Synthetic point course', slug: randomUUID(), instructorId: admin.id, level: 'beginner' } });
    const eventAt = new Date(Date.now() - 60000);
    const source = await db.enrollment.create({ data: { userId: user.id, courseId: course.id, status: 'completed', completedAt: eventAt } });
    const version = (await db.platformPolicyRevision.aggregate({ where: { group: 'points' }, _max: { version: true } }))._max.version ?? 0;
    const policy = await db.platformPolicyRevision.create({ data: { group: 'points', version: version + 1, status: 'scheduled',
      content: { enabled: true, expireAfterMonths: 1, maxDaily: 100, rules: [{ event: 'course.completed', points: 80 }] },
      createdById: admin.id, approvedById: admin.id, approvedAt: new Date(eventAt.getTime() - 1000), effectiveAt: new Date(eventAt.getTime() - 1000) } });
    const reward = await db.tmiReward.create({ data: { title: 'Synthetic point gift', kind: 'gift', cost: 60,
      status: 'active', startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 3600000), createdById: admin.id } });

    await db.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const sql of buildRuntimePointPrivilegeStatement(`postgresql://${role}@localhost/test`).split(';').filter(s => s.trim()))
      await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe(`GRANT SELECT ON users,enrollments,platform_policy_revisions,tmi_rewards,tmi_redemptions,tmi_entitlements TO "${role}"`);
    // Row-level FOR UPDATE requires UPDATE privilege on at least one column.
    await db.$executeRawUnsafe(`GRANT UPDATE(id) ON users TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT UPDATE(redeemed_count,updated_at) ON tmi_rewards TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT UPDATE(status,revoked_at) ON tmi_entitlements TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON tmi_redemptions,tmi_entitlements,audit_logs TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT(id) ON audit_logs TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT(migration_name,checksum,finished_at,rolled_back_at) ON _prisma_migrations TO "${role}"`);
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` }) });
    const audit = new AuditService(runtime), ledger = new PointLedgerService(audit);
    const awards = new ActivityPointService(runtime, audit);
    const redemptions = new TmiRedemptionService(runtime, audit, {}, ledger);
    assert.equal((await readActivityPointReadiness(runtime)).ready, true);
    await db.$executeRawUnsafe('ALTER TABLE tmi_ledger_entries DISABLE TRIGGER point_posting_receipt_required');
    try { assert.equal((await readActivityPointReadiness(runtime)).ready, false); }
    finally { await db.$executeRawUnsafe('ALTER TABLE tmi_ledger_entries ENABLE TRIGGER point_posting_receipt_required'); }
    assert.equal((await readActivityPointReadiness(runtime)).ready, true);
    console.log('POINT_SCHEMA_AND_RESTRICTED_RUNTIME_READINESS=PASS');

    const duplicated = await Promise.all([awards.recordCourseCompletion(source.id), awards.recordCourseCompletion(source.id)]);
    assert.equal(duplicated[0].id, duplicated[1].id);
    assert.equal(duplicated[0].policyRevisionId, policy.id);
    assert.equal(await db.pointActivityReceipt.count({ where: { sourceId: source.id } }), 1);
    assert.equal((await redemptions.wallet(user.id)).current, 80);
    console.log('POINT_CANONICAL_AWARD_RESTRICTED_ROLE_AND_REPLAY=PASS');

    const raced = await Promise.allSettled([redemptions.redeem(user.id, reward.id, { idempotencyKey: randomUUID() }),
      redemptions.redeem(user.id, reward.id, { idempotencyKey: randomUUID() })]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await redemptions.wallet(user.id)).current, 20);
    const redemption = raced.find(r => r.status === 'fulfilled').value;
    const refunds = await Promise.all([redemptions.refund(admin.id, redemption.id, {}), redemptions.refund(admin.id, redemption.id, {})]);
    assert.equal(refunds.filter(r => !r.idempotent).length, 1);
    assert.equal((await redemptions.wallet(user.id)).current, 80);
    const returned = await db.tmiLedgerEntry.findFirstOrThrow({ where: { redemptionId: redemption.id, kind: 'refund' } });
    assert.equal(returned.sourceType, 'platform_activity_refund');
    assert.equal(returned.expiresAt.getTime(), duplicated[0].expiresAt.getTime());
    console.log('POINT_CONCURRENT_REDEMPTION_AND_NATIVE_REFUND=PASS');

    const provenanceCount = await db.tmiLedgerEntry.count({ where: { userId: user.id } });
    await assert.rejects(runtime.tmiLedgerEntry.create({ data: { userId: user.id, actorId: user.id,
      kind: 'earn', amount: 80, sourceType: 'platform_activity', sourceId: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000) } }), /Point activity receipt required/);
    await assert.rejects(runtime.tmiLedgerEntry.create({ data: { userId: user.id, actorId: user.id,
      kind: 'expiry', amount: 1, sourceType: 'platform_activity_expiry', sourceId: duplicated[0].ledgerEntryId } }), /Point expiry receipt required/);
    await assert.rejects(db.tmiLedgerEntry.update({ where: { id: duplicated[0].ledgerEntryId }, data: { amount: 1 } }), /immutable/);
    await assert.rejects(runtime.tmiLedgerEntry.create({ data: { userId: user.id, actorId: admin.id,
      redemptionId: redemption.id, kind: 'refund', amount: returned.amount, sourceType: 'platform_activity_refund',
      sourceId: `${redemption.id}:${duplicated[0].ledgerEntryId}`, metadata: returned.metadata,
      expiresAt: new Date(returned.expiresAt.getTime() + 86400000) } }), /Point refund source mismatch/);
    assert.equal(await db.tmiLedgerEntry.count({ where: { userId: user.id } }), provenanceCount);
    console.log('POINT_ORPHAN_POSTING_AND_REFUND_PROVENANCE_GUARDS=PASS');

    const before = await db.tmiLedgerEntry.count({ where: { userId: user.id } });
    const failingAudit = { record: async () => { throw new Error('Synthetic audit rollback'); } };
    await assert.rejects(new TmiRedemptionService(runtime, failingAudit, {}, ledger)
      .redeem(user.id, reward.id, { idempotencyKey: randomUUID() }), /Synthetic audit rollback/);
    assert.equal(await db.tmiLedgerEntry.count({ where: { userId: user.id } }), before);
    assert.equal((await redemptions.wallet(user.id)).current, 80);
    console.log('POINT_AUDIT_FAILURE_ROLLS_BACK_DEBIT=PASS');

    // Historic fixture exercises actual worker expiry without rewriting existing entries.
    const expiredUser = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic expiry learner' } });
    const oldAt = new Date(Date.now() - 70 * 86400000);
    const { evaluateActivityPointAward } = require('../dist/src/modules/tmi/activity-point-policy.js');
    const oldExpiry = evaluateActivityPointAward({ enabled: true, expireAfterMonths: 1, maxDaily: 100,
      rules: [{ event: 'course.completed', points: 80 }] }, 'course.completed', oldAt, oldAt, 0).expiresAt;
    const oldCourse = await db.course.create({ data: { title: 'Synthetic historic course', slug: randomUUID(), instructorId: admin.id, level: 'beginner' } });
    const oldSource = await db.enrollment.create({ data: { userId: expiredUser.id, courseId: oldCourse.id, status: 'completed', completedAt: oldAt } });
    const oldPolicy = await db.platformPolicyRevision.create({ data: { group: 'points', version: version + 2, status: 'scheduled',
      content: { enabled: true, expireAfterMonths: 1, maxDaily: 100, rules: [{ event: 'course.completed', points: 80 }] },
      createdById: admin.id, approvedById: admin.id, approvedAt: new Date(oldAt.getTime() - 1000), effectiveAt: new Date(oldAt.getTime() - 1000) } });
    await db.$transaction(async tx => {
      const entry = await tx.tmiLedgerEntry.create({ data: { userId: expiredUser.id, kind: 'earn', amount: 80,
        sourceType: 'platform_activity', sourceId: oldSource.id, actorId: expiredUser.id, occurredAt: oldAt, expiresAt: oldExpiry } });
      await tx.pointActivityReceipt.create({ data: { userId: expiredUser.id, sourceId: oldSource.id, eventType: 'course.completed',
        policyRevisionId: oldPolicy.id, outcome: 'awarded', amount: 80, occurredAt: oldAt, createdAt: oldAt, expiresAt: oldExpiry, ledgerEntryId: entry.id } });
    });
    await db.platformPolicyRevision.create({ data: { group: 'points', version: version + 3, status: 'scheduled',
      content: { enabled: false, expireAfterMonths: 1, maxDaily: 0, rules: [] }, createdById: admin.id,
      approvedById: admin.id, approvedAt: new Date(), effectiveAt: new Date() } });
    assert.equal((await redemptions.wallet(expiredUser.id)).current, 0);
    const worker = new ActivityPointWorker(runtime, awards, ledger);
    await Promise.all([worker.runBatch(), new ActivityPointWorker(runtime, awards, ledger).runBatch()]);
    assert.equal(await db.pointExpirySettlement.count({ where: { userId: expiredUser.id } }), 1);
    assert.equal(await db.tmiLedgerEntry.count({ where: { userId: expiredUser.id, kind: 'expiry' } }), 1);
    console.log('POINT_CONCURRENT_WORKER_EXPIRY_WHILE_ACCRUAL_DISABLED=PASS');

    await assert.rejects(runtime.pointActivityReceipt.updateMany({ data: { amount: 1 } }));
    await assert.rejects(runtime.pointActivityReceipt.deleteMany({}));
    await assert.rejects(runtime.$executeRawUnsafe("SELECT setval('tmi_ledger_entries_posting_sequence_seq',1)"));
    console.log('POINT_RUNTIME_IMMUTABILITY_AND_SEQUENCE_BOUNDARY=PASS');
  } finally {
    if (runtime) await runtime.$disconnect();
    // Keep immutable synthetic fixtures for later replay assertions; dispose the whole CI DB.
    await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => {});
    await db.$executeRawUnsafe(`DROP ROLE "${role}"`).catch(() => {});
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
