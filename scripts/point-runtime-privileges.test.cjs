'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { buildRuntimePointPrivilegeStatement } = require('./membership-runtime-privileges.cjs');

test('point runtime can append receipts and use posting order but cannot rewrite receipts or reset the sequence', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE point_runtime NOLOGIN; CREATE ROLE unrelated_runtime NOLOGIN;
      CREATE TABLE tmi_ledger_entries(id INTEGER, posting_sequence BIGSERIAL);
      CREATE TABLE point_activity_receipts(id INTEGER); CREATE TABLE point_expiry_settlements(id INTEGER);`);
    await db.exec(buildRuntimePointPrivilegeStatement('postgresql://point_runtime@localhost/test'));
    await db.exec('SET ROLE point_runtime');
    await db.exec('INSERT INTO tmi_ledger_entries(id) VALUES (1); INSERT INTO point_activity_receipts VALUES (1); INSERT INTO point_expiry_settlements VALUES (1)');
    for (const table of ['point_activity_receipts', 'point_expiry_settlements']) {
      assert.equal((await db.query('SELECT count(*)::int AS count FROM ' + table)).rows[0].count, 1);
      for (const sql of ['UPDATE ' + table + ' SET id=2', 'DELETE FROM ' + table, 'TRUNCATE ' + table])
        await assert.rejects(db.exec(sql), /permission denied/);
    }
    await assert.rejects(db.exec("SELECT setval('tmi_ledger_entries_posting_sequence_seq',1)"), /permission denied/);
    await db.exec('RESET ROLE; SET ROLE unrelated_runtime');
    await assert.rejects(db.exec('SELECT * FROM point_activity_receipts'), /permission denied/);
  } finally { await db.close(); }
});
