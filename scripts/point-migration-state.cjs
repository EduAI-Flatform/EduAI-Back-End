'use strict';
const POINT_LEDGER_HISTORY_QUERY = `SELECT count(*)::text AS "rowCount",
  md5(COALESCE(string_agg(md5((to_jsonb(t)-'posting_sequence')::text),'' ORDER BY id),'')) AS hash
  FROM public.tmi_ledger_entries t`;
const POINT_POLICY_HISTORY_QUERY = `SELECT count(*)::text AS "rowCount",
  md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash
  FROM public.platform_policy_revisions t WHERE "group"='points'`;

async function readPointHistoryState(client) {
  const ledger = (await client.query(POINT_LEDGER_HISTORY_QUERY)).rows[0];
  const policies = (await client.query(POINT_POLICY_HISTORY_QUERY)).rows[0];
  return { ledger, policies };
}
function validDigest(value) {
  return value && typeof value.rowCount === 'string' && /^(0|[1-9]\d*)$/.test(value.rowCount)
    && typeof value.hash === 'string' && /^[a-f0-9]{32}$/.test(value.hash);
}
function assertPointHistoryPreserved(before, after) {
  for (const key of ['ledger', 'policies']) {
    if (!validDigest(before?.[key]) || !validDigest(after?.[key])
      || before[key].rowCount !== after[key].rowCount || before[key].hash !== after[key].hash) {
      const error = new Error('POINT_HISTORY_CHANGED');
      error.failureClass = 'POINT_HISTORY_CHANGED';
      throw error;
    }
  }
  return { historicalPointRowsPreserved: true, pointPoliciesPreserved: true };
}
module.exports = { POINT_LEDGER_HISTORY_QUERY, POINT_POLICY_HISTORY_QUERY, readPointHistoryState, assertPointHistoryPreserved };
