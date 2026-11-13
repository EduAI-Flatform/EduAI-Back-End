'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { readCardQuotaHistoryState, assertCardQuotaHistoryPreserved } = require('./card-quota-migration-state.cjs');
test('compares existing entitlement facts across additive provenance columns and detects history edits', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE service_entitlement_grants(id text PRIMARY KEY, quota bigint);
      CREATE TABLE service_entitlement_usage(id text PRIMARY KEY, quantity bigint);
      CREATE TABLE platform_policy_revisions(id text PRIMARY KEY,"group" text,content jsonb);
      INSERT INTO service_entitlement_grants VALUES ('purchased',9);
      INSERT INTO service_entitlement_usage VALUES ('spent',2);
      INSERT INTO platform_policy_revisions VALUES ('old','membership','{"enabled":false}');`);
    const before = await readCardQuotaHistoryState(db);
    await db.exec(`ALTER TABLE service_entitlement_grants ADD COLUMN card_policy_revision_id uuid,
      ADD COLUMN card_tier_code text, ADD COLUMN card_source_digest char(64), ADD COLUMN card_qualification jsonb;`);
    assert.equal(assertCardQuotaHistoryPreserved(before, await readCardQuotaHistoryState(db)).historicalServiceUsagePreserved, true);
    for (const statement of ["UPDATE service_entitlement_grants SET quota=8", "DELETE FROM service_entitlement_usage",
      "UPDATE platform_policy_revisions SET content='{}'"]) {
      await db.exec('BEGIN');
      await db.exec(statement);
      const awaitSnapshot = await readCardQuotaHistoryState(db);
      assert.throws(() => assertCardQuotaHistoryPreserved(before, awaitSnapshot), /CARD_QUOTA_HISTORY_CHANGED/);
      await db.exec('ROLLBACK');
    }
  } finally { await db.close(); }
});
test('missing or malformed history evidence fails closed', () => {
  const before = Object.fromEntries(['grants','usage','policies'].map(key => [key, { rowCount: '0', hash: 'a'.repeat(32) }]));
  assertCardQuotaHistoryPreserved(before, structuredClone(before));
  assert.throws(() => assertCardQuotaHistoryPreserved(before, null));
  assert.throws(() => assertCardQuotaHistoryPreserved(before, { ...before, usage: { rowCount: '0', hash: 'invalid' } }));
});
