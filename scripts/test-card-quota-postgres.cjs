'use strict';
// Disposable replay database only. No .env loading, providers or production writes.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');

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
  try {
    await Promise.all(clients.map(client => client.connect()));
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
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    await db.$disconnect();
  }
}

main().catch(error => {
  process.stderr.write(`CARD_QUOTA_POSTGRES=FAIL ${error?.name || 'Error'}\n`);
  process.exitCode = 1;
});
