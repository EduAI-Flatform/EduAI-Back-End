'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { readPointHistoryState, assertPointHistoryPreserved } = require('./point-migration-state.cjs');

test('point migration adds posting order without changing historical amounts, metadata or policies', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE tmi_ledger_entries(id TEXT PRIMARY KEY, amount INTEGER, metadata JSONB);
      CREATE TABLE platform_policy_revisions(id TEXT PRIMARY KEY, "group" TEXT, content JSONB);
      INSERT INTO tmi_ledger_entries VALUES ('old-credit',100,'{"source":"legacy"}');
      INSERT INTO platform_policy_revisions VALUES ('old-policy','points','{"enabled":false}');`);
    const before = await readPointHistoryState(db);
    await db.exec('ALTER TABLE tmi_ledger_entries ADD COLUMN posting_sequence BIGSERIAL NOT NULL');
    assertPointHistoryPreserved(before, await readPointHistoryState(db));
    await db.exec("UPDATE tmi_ledger_entries SET amount=99 WHERE id='old-credit'");
    const changed = await readPointHistoryState(db);
    assert.throws(() => assertPointHistoryPreserved(before, changed), /POINT_HISTORY_CHANGED/);
  } finally { await db.close(); }
});
test('policy changes and missing snapshots fail closed rather than silently rewriting history', async () => {
  const before = { ledger: { rowCount: '1', hash: 'a'.repeat(32) }, policies: { rowCount: '1', hash: 'b'.repeat(32) } };
  assertPointHistoryPreserved(before, structuredClone(before));
  assert.throws(() => assertPointHistoryPreserved(before, { ...before, policies: { rowCount: '1', hash: 'c'.repeat(32) } }), /POINT_HISTORY_CHANGED/);
  assert.throws(() => assertPointHistoryPreserved(before, null), /POINT_HISTORY_CHANGED/);
});
