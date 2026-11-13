'use strict';
// Disposable replay database only. No .env loading, providers or production writes.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { verifyCardQuotaSchema } = require('./verify-card-quota-schema.cjs');

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(process.env.CI, 'true', 'Disposable CI required');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.username, 'eduai_migration_replay');
  assert.equal(url.pathname, '/eduai_migration_replay');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../dist/generated/prisma/client.js');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const clients = [new Client({ connectionString: process.env.DATABASE_URL }), new Client({ connectionString: process.env.DATABASE_URL })];
  const hash = () => randomBytes(32).toString('hex');
  const at = new Date('2026-11-10T00:00:00Z');
  const start = new Date('2026-11-01T00:00:00Z'), end = new Date('2026-12-01T00:00:00Z');
  const role = 'card_' + randomUUID().replaceAll('-', '');
  let runtime;
  try {
    await Promise.all(clients.map(client => client.connect()));
    assert.equal((await verifyCardQuotaSchema(clients[0])).cardQuotaGuardsEnabled, true);
    await clients[0].query('ALTER TABLE service_entitlement_grants DISABLE TRIGGER membership_card_grant_validate');
    try { await assert.rejects(() => verifyCardQuotaSchema(clients[0]), /CARD_QUOTA_SCHEMA_NOT_READY/); }
    finally { await clients[0].query('ALTER TABLE service_entitlement_grants ENABLE TRIGGER membership_card_grant_validate'); }
    assert.equal((await verifyCardQuotaSchema(clients[0])).cardQuotaGuardsEnabled, true);
    const admin = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic quota operator' } });
    let version = (await db.platformPolicyRevision.aggregate({ where: { group: 'membership' }, _max: { version: true } }))._max.version ?? 0;
    for (let round = 0; round < 10; round++) {
      const user = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic quota learner' } });
      const definition = await db.serviceEntitlementDefinition.create({ data: { code: `RACE_${randomBytes(8).toString('hex').toUpperCase()}`,
        valueType: 'metered', resetPeriod: 'calendar_month', displayName: 'Synthetic race quota', createdById: admin.id } });
      const policy = await db.platformPolicyRevision.create({ data: { group: 'membership', version: ++version, status: 'scheduled',
        createdById: admin.id, approvedById: admin.id, createdAt: new Date('2026-10-28'), approvedAt: new Date('2026-10-29'), effectiveAt: start,
        content: { enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
          serviceLimits: { enabled: true, consumptionPriority: 'card_first', termAnchorAt: '', termMonths: 0 },
          tiers: [{ code: 'member', name: { vi: 'Member', en: 'Member' }, threshold: 0, benefits: [], serviceLimits: [] },
            ...['platinum', 'diamond'].map((code, index) => ({ code, name: { vi: code, en: code }, threshold: (index + 1) * 100,
              benefits: [], serviceLimits: [{ definitionId: definition.id, quota: '1' }] }))] } } });
      const grants = [];
      for (const [index, tier] of ['platinum', 'diamond'].entries()) {
        grants.push(await db.serviceEntitlementGrant.create({ data: { userId: user.id, definitionId: definition.id,
          sourceType: 'MEMBERSHIP_CARD', sourceId: hash(), valueType: 'metered', resetPeriod: 'calendar_month', quota: 1n,
          startsAt: start, endsAt: end, createdAt: at, cardPolicyRevisionId: policy.id, cardTierCode: tier, cardSourceDigest: hash(),
          cardQualification: { evaluatedAt: at.toISOString(), windowStartsAt: '2025-11-10T00:00:00.000Z', windowEndsAt: at.toISOString(),
            qualifyingAmountMinor: String((index + 1) * 100), basis: 'spend', currency: 'VND' } } }));
      }
      const insert = (client, grant) => client.query(`INSERT INTO service_entitlement_usage
        (grant_id,user_id,operation_key_hash,request_hash,quantity,period_starts_at,period_ends_at,remaining_after,created_at)
        VALUES($1,$2,$3,$4,1,$5,$6,0,$7)`, [grant.id, user.id, hash(), hash(), start, end, at]);
      await Promise.all(clients.map(client => client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')));
      // Establish both snapshots before either insert; a sequential test cannot expose stale counters.
      await Promise.all(clients.map(client => client.query('SELECT COUNT(*) FROM service_entitlement_usage WHERE user_id=$1', [user.id])));
      const raced = await Promise.allSettled(clients.map(async (client, index) => {
        try { await insert(client, grants[index]); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      }));
      assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1, 'Exactly one last-unit request commits');
      const rejected = raced.find(result => result.status === 'rejected');
      assert.ok(['40001', '23514'].includes(rejected.reason.code), 'Only serialization/quota rejection is expected');
      const loserIndex = raced.findIndex(result => result.status === 'rejected');
      const loser = clients[loserIndex];
      await loser.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await assert.rejects(() => insert(loser, grants[loserIndex]), error => error.code === '23514' && /quota exhausted/.test(error.message));
      } finally { await loser.query('ROLLBACK'); }
      const usage = await db.serviceEntitlementUsage.aggregate({ where: { userId: user.id }, _sum: { quantity: true }, _count: true });
      assert.equal(usage._sum.quantity, 1n);
      assert.equal(usage._count, 1);
    }
    console.log('CARD_CROSS_TIER_LAST_UNIT_SERIALIZABLE_RACES=PASS rounds=10');

    const { ServiceEntitlementService } = require('../dist/src/modules/memberships/service-entitlement.service.js');
    await db.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT ON users,commerce_orders,commerce_settlements,commerce_refunds,
      platform_policy_revisions,service_entitlement_definitions,service_entitlement_grants,service_entitlement_usage,library_resources TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON service_entitlement_grants,service_entitlement_usage TO "${role}"`);
    // Row locks require an UPDATE privilege; immutable fact triggers still forbid changing these facts.
    for (const table of ['users','platform_policy_revisions','service_entitlement_definitions','service_entitlement_grants'])
      await db.$executeRawUnsafe(`GRANT UPDATE(id) ON ${table} TO "${role}"`);
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` }) });
    const { readCardServiceReadiness, CARD_QUOTA_SCHEMA_MIGRATION, CARD_QUOTA_SCHEMA_SHA256 } = require('../dist/src/modules/membership-cards/card-service-readiness.js');
    const { REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS } = require('./run-production-migrations.cjs');
    assert.deepEqual(REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS, [{ name: CARD_QUOTA_SCHEMA_MIGRATION, sha256: CARD_QUOTA_SCHEMA_SHA256 }]);
    await db.$executeRawUnsafe(`GRANT SELECT(migration_name,checksum,finished_at,rolled_back_at) ON _prisma_migrations TO "${role}"`);
    assert.equal((await readCardServiceReadiness(db)).ready, false, 'Owner/superuser is not an admissible runtime role');
    assert.equal((await readCardServiceReadiness(runtime)).ready, true);
    await db.$executeRawUnsafe('ALTER TABLE service_entitlement_grants DISABLE TRIGGER membership_card_grant_validate');
    try { assert.equal((await readCardServiceReadiness(runtime)).ready, false); }
    finally { await db.$executeRawUnsafe('ALTER TABLE service_entitlement_grants ENABLE TRIGGER membership_card_grant_validate'); }
    assert.equal((await readCardServiceReadiness(runtime)).ready, true);
    console.log('CARD_QUOTA_RUNTIME_PIN_GUARDS_AND_RESTRICTED_READINESS=PASS');
    const service = new ServiceEntitlementService(runtime, { app: { nodeEnv: 'test' }, commerce: { idempotencySecret: 'synthetic-card-operation-key'.repeat(3) } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, fullName: 'Synthetic runtime learner' } });
    const definition = await db.serviceEntitlementDefinition.create({ data: { code: 'AI_CHAT', valueType: 'metered',
      resetPeriod: 'calendar_month', unitLabel: 'request', displayName: 'Synthetic request quota', createdById: admin.id } });
    const runtimePolicy = async (quota, effectiveAt, priority = 'card_first', enabled = true) => db.platformPolicyRevision.create({
      data: { group: 'membership', version: ++version, status: 'scheduled', createdById: admin.id, approvedById: admin.id,
        createdAt: new Date('2026-10-28'), approvedAt: new Date('2026-10-29'), effectiveAt,
        content: { enabled, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
          serviceLimits: { enabled: true, consumptionPriority: priority, termAnchorAt: '', termMonths: 0 },
          tiers: [{ code: 'custom', name: { vi: 'Synthetic', en: 'Synthetic' }, threshold: 0, benefits: [],
            serviceLimits: [{ definitionId: definition.id, quota: String(quota) }] }] } } });
    const firstPolicy = await runtimePolicy(3, start);
    assert.equal((await service.resolve(user.id, 'AI_CHAT', at)).remaining, '3');
    assert.equal(await db.serviceEntitlementGrant.count({ where: { userId: user.id } }), 0, 'Read resolution must not create grants');
    const key = randomUUID();
    assert.equal((await service.consume(user.id, 'AI_CHAT', 1n, key, at)).remaining, '2');
    assert.equal((await service.consume(user.id, 'AI_CHAT', 1n, key, at)).idempotent, true);
    const firstGrant = await db.serviceEntitlementGrant.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(firstGrant.cardPolicyRevisionId, firstPolicy.id);
    assert.equal(firstGrant.cardTierCode, 'custom');
    assert.equal(await db.serviceEntitlementUsage.count({ where: { userId: user.id } }), 1);
    const nextAt = new Date('2026-11-16');
    const raisedPolicy = await runtimePolicy(5, new Date('2026-11-15'));
    const { loadCardServiceImpact } = require('../dist/src/modules/membership-cards/card-service-impact.js');
    const { inspectCardServiceBindings } = require('../dist/src/modules/membership-cards/card-service-bindings.js');
    assert.equal((await inspectCardServiceBindings(runtime, raisedPolicy.content)).ready, true);
    const impact = await loadCardServiceImpact(runtime, [firstPolicy.content, raisedPolicy.content], [user.id], nextAt);
    assert.equal(impact.complete, true);
    assert.equal(impact.project(user.id, firstPolicy.content, firstPolicy.content.tiers[0])[0].remaining, '2');
    assert.equal(impact.project(user.id, raisedPolicy.content, raisedPolicy.content.tiers[0])[0].remaining, '4');
    assert.equal(await db.serviceEntitlementGrant.count({ where: { userId: user.id } }), 1, 'Impact must not create a new policy grant');
    console.log('CARD_QUOTA_CONSUMED_IMPACT_AND_BINDINGS_RESTRICTED_PRISMA=PASS');
    assert.equal((await service.resolve(user.id, 'AI_CHAT', nextAt)).remaining, '4');
    assert.equal((await service.consume(user.id, 'AI_CHAT', 1n, randomUUID(), nextAt)).remaining, '3');
    assert.equal(await db.serviceEntitlementGrant.count({ where: { userId: user.id } }), 2);
    const runtimeRace = await Promise.allSettled([service.consume(user.id, 'AI_CHAT', 2n, randomUUID(), nextAt),
      service.consume(user.id, 'AI_CHAT', 2n, randomUUID(), nextAt)]);
    assert.equal(runtimeRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(runtimeRace.find(result => result.status === 'rejected').reason.getStatus(), 403);
    assert.equal((await service.resolve(user.id, 'AI_CHAT', nextAt)).remaining, '1');
    const purchased = await db.serviceEntitlementGrant.create({ data: { userId: user.id, definitionId: definition.id,
      sourceType: 'ADMIN', sourceId: hash(), valueType: 'metered', resetPeriod: 'calendar_month', quota: 9n, startsAt: start, endsAt: end } });
    const paidFirstAt = new Date('2026-11-21');
    await runtimePolicy(7, new Date('2026-11-20'), 'purchased_first');
    const paidKey = randomUUID();
    assert.equal((await service.consume(user.id, 'AI_CHAT', 1n, paidKey, paidFirstAt)).remaining, '8');
    assert.equal((await db.serviceEntitlementUsage.findUniqueOrThrow({ where: { userId_operationKeyHash: {
      userId: user.id, operationKeyHash: service.operationKeyHash(paidKey) } } })).grantId, purchased.id);
    assert.equal(await db.serviceEntitlementGrant.count({ where: { userId: user.id, sourceType: 'MEMBERSHIP_CARD' } }), 2,
      'Unused card quota must not be provisioned when purchased quota is selected');
    await runtimePolicy(7, new Date('2026-11-25'), 'card_first', false);
    assert.equal((await service.resolve(user.id, 'AI_CHAT', new Date('2026-11-26'))).remaining, '8', 'Disabling card preserves purchased service quota');
    const usageBeforeDisabledRequest = await db.serviceEntitlementUsage.count({ where: { userId: user.id } });
    assert.equal((await service.consumeServerRequest(user.id, 'AI_CHAT', new Date('2026-11-26'))).consumed, '0');
    assert.equal(await db.serviceEntitlementUsage.count({ where: { userId: user.id } }), usageBeforeDisabledRequest);
    console.log('CARD_RUNTIME_PRISMA_READ_ONLY_PROVENANCE_REPLAY_POOLING_PRIORITY_AND_RACE=PASS');

    const { AiRateLimitService } = require('../dist/src/modules/ai/ai-rate-limit.service.js');
    const { AiSummaryService } = require('../dist/src/modules/ai/ai-summary.service.js');
    const summaryDefinition = await db.serviceEntitlementDefinition.create({ data: { code: 'AI_SUMMARY', valueType: 'metered',
      resetPeriod: 'calendar_month', unitLabel: 'request', displayName: 'Synthetic summary request', createdById: admin.id } });
    await db.platformPolicyRevision.create({ data: { group: 'membership', version: ++version, status: 'scheduled',
      createdById: admin.id, approvedById: admin.id, createdAt: new Date('2026-10-28'), approvedAt: new Date('2026-10-29'), effectiveAt: new Date('2026-11-27'),
      content: { enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
        serviceLimits: { enabled: true, consumptionPriority: 'card_first', termAnchorAt: '', termMonths: 0 },
        tiers: [{ code: 'custom', name: { vi: 'Synthetic', en: 'Synthetic' }, threshold: 0, benefits: [],
          serviceLimits: [{ definitionId: summaryDefinition.id, quota: '1' }] }] } } });
    const category = await db.libraryCategory.create({ data: { name: 'Synthetic source', slug: randomUUID() } });
    const resource = await db.libraryResource.create({ data: { ownerId: user.id, categoryId: category.id,
      title: 'Synthetic private source', description: 'Only supplied synthetic content', type: 'document', visibility: 'private' } });
    let providerCalls = 0;
    const mockProvider = { complete: async () => { providerCalls++; return { content: 'Synthetic summary' }; } };
    const limiter = new AiRateLimitService({ getClient: () => undefined }, { app: { nodeEnv: 'test' } }, {
      consumeServerRequest: (userId, code) => service.consumeServerRequest(userId, code, new Date('2026-11-28')),
    });
    const summary = new AiSummaryService(runtime, mockProvider, limiter, {});
    const summaryInput = { sourceType: 'library_resource', sourceId: resource.id };
    const beforeDeniedSource = await db.serviceEntitlementUsage.count({ where: { userId: user.id } });
    await assert.rejects(() => summary.summarize({ id: admin.id, roles: ['student'] }, summaryInput), error => error.getStatus() === 404);
    assert.equal(providerCalls, 0);
    assert.equal(await db.serviceEntitlementUsage.count({ where: { userId: user.id } }), beforeDeniedSource);
    assert.equal((await summary.summarize({ id: user.id, roles: ['student'] }, summaryInput)).summary, 'Synthetic summary');
    await assert.rejects(() => summary.summarize({ id: user.id, roles: ['student'] }, summaryInput), error => error.getStatus() === 403);
    assert.equal(providerCalls, 1, 'Exhausted service quota must stop before a repeated provider attempt');
    const summaryGrants = await db.serviceEntitlementGrant.findMany({ where: { userId: user.id, definitionId: summaryDefinition.id } });
    assert.equal(summaryGrants.length, 1);
    assert.equal(await db.serviceEntitlementUsage.count({ where: { grantId: summaryGrants[0].id } }), 1);
    console.log('CARD_AI_SUMMARY_REAL_PRISMA_SOURCE_ACCESS_AND_PROVIDER_ADMISSION=PASS');
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    await runtime?.$disconnect();
    await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => {});
    await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    await db.$disconnect();
  }
}

main().catch(error => {
  process.stderr.write(`CARD_QUOTA_POSTGRES=FAIL ${error?.name || 'Error'}\n`);
  process.exitCode = 1;
});
