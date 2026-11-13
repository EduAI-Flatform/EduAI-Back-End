'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCardQuotaSchema } = require('./verify-card-quota-schema.cjs');
const { REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS } = require('./run-production-migrations.cjs');
const snapshot = () => [
  [{ checksum: REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS[0].sha256 }], [],
  ['membership_card_grant_provenance_immutable','membership_card_grant_validate'].map(name => ({ name, table: 'service_entitlement_grants', enabled: 'O' }))
    .concat([{ name: 'membership_card_policy_facts_immutable', table: 'platform_policy_revisions', enabled: 'O' },
      { name: 'service_entitlement_usage_validate', table: 'service_entitlement_usage', enabled: 'O' },
      { name: 'service_entitlement_usage_append_only', table: 'service_entitlement_usage', enabled: 'O' }]),
  ['membership_card_policy_fk','membership_card_grant_provenance_check'].map(name => ({ name, valid: true })),
];
const client = rows => ({ query: async () => ({ rows: rows.shift() }) });
test('verifies the pinned schema and enabled guards without activating policy or writing data', async () => {
  assert.deepEqual(await verifyCardQuotaSchema(client(snapshot())), { cardQuotaSchemaReadable: true, cardQuotaGuardsEnabled: true });
});
test('rejects missing/changed migration, disabled or misplaced triggers and invalid constraints', async () => {
  for (const change of [rows => { rows[0] = []; }, rows => { rows[0][0].checksum = '0'.repeat(64); },
    rows => { rows[2][0].enabled = 'D'; }, rows => { rows[2][0].table = 'other'; },
    rows => { rows[3][0].valid = false; }, rows => { rows[3] = []; }]) {
    const rows = snapshot(); change(rows);
    await assert.rejects(() => verifyCardQuotaSchema(client(rows)), /CARD_QUOTA_SCHEMA_NOT_READY/);
  }
});
test('does not hide missing runtime access to the added grant columns', async () => {
  const rows = snapshot(); let calls = 0;
  await assert.rejects(() => verifyCardQuotaSchema({ query: async () => {
    if (++calls === 2) throw new Error('permission denied');
    return { rows: rows.shift() };
  } }), /permission denied/);
});
