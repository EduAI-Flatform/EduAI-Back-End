'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyAuthSessionSchema } = require('./verify-auth-session-schema.cjs');
const { REVIEWED_AUTH_SESSION_MIGRATIONS } = require('./run-production-migrations.cjs');
function fixture(change = {}) {
  const data = { ledger: [{ checksum: REVIEWED_AUTH_SESSION_MIGRATIONS[0].sha256 }],
    columns: [{ table: 'users', name: 'auth_revision', type: 'integer', required: true, default: '0' },
      { table: 'refresh_tokens', name: 'session_family_id', type: 'uuid', required: false, default: null }],
    constraints: [{ valid: true, definition: 'CHECK ((auth_revision >= 0))' }],
    indexes: [{ valid: true, ready: true, unique: false, definition: 'CREATE INDEX i ON public.refresh_tokens USING btree (user_id, session_family_id)' }],
    privileges: [{ readRevision: true, updateRevision: true, readFamily: true, insertFamily: true }], ...change };
  return { query: async sql => ({ rows: sql.includes('_prisma_migrations') ? data.ledger : sql.includes('pg_attribute') ? data.columns
    : sql.includes('pg_constraint') ? data.constraints : sql.includes('pg_index') ? data.indexes : sql.includes('has_column_privilege') ? data.privileges : [] }) };
}
test('verifies the pinned schema and exact required runtime privileges without reading user values', async () => {
  assert.equal((await verifyAuthSessionSchema(fixture())).authSessionRuntimePrivilegesReady, true);
});
test('fails closed on missing/drifted schema, ledger, index or runtime privileges', async () => {
  for (const change of [{ ledger: [] }, { ledger: [{ checksum: '0'.repeat(64) }] }, { columns: [] },
    { constraints: [{ valid: false, definition: 'CHECK ((auth_revision >= 0))' }] }, { indexes: [] },
    { constraints: [{ valid: true, definition: 'CHECK ((auth_revision >= 0) OR true)' }] },
    { indexes: [{ valid: true, ready: true, unique: true, definition: '(user_id, session_family_id)' }] },
    { privileges: [{}] }, { privileges: [{ readRevision: true }] },
    { privileges: [{ readRevision: true, updateRevision: false, readFamily: true, insertFamily: true }] }]) {
    await assert.rejects(() => verifyAuthSessionSchema(fixture(change)));
  }
});
