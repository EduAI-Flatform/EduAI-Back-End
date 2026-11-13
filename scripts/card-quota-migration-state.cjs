'use strict';
// Subtract only newly added columns, so the same query works before and after the additive migration.
const CARD_QUOTA_HISTORY_QUERIES = Object.freeze({
  grants: `SELECT count(*)::text AS "rowCount", md5(COALESCE(string_agg(md5((to_jsonb(t)
    -'card_policy_revision_id'-'card_tier_code'-'card_source_digest'-'card_qualification')::text),'' ORDER BY id),'')) AS hash
    FROM public.service_entitlement_grants t`,
  usage: `SELECT count(*)::text AS "rowCount", md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash
    FROM public.service_entitlement_usage t`,
  policies: `SELECT count(*)::text AS "rowCount", md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),'')) AS hash
    FROM public.platform_policy_revisions t WHERE "group"='membership'`,
});
async function readCardQuotaHistoryState(client) {
  const result = {};
  for (const [key, query] of Object.entries(CARD_QUOTA_HISTORY_QUERIES)) result[key] = (await client.query(query)).rows[0];
  return result;
}
function assertCardQuotaHistoryPreserved(before, after) {
  for (const key of Object.keys(CARD_QUOTA_HISTORY_QUERIES)) {
    const valid = value => value && typeof value.rowCount === 'string' && typeof value.hash === 'string'
      && /^(0|[1-9]\d*)$/.test(value.rowCount) && /^[a-f0-9]{32}$/.test(value.hash);
    if (!valid(before?.[key]) || !valid(after?.[key]) || before[key].rowCount !== after[key].rowCount || before[key].hash !== after[key].hash) {
      const error = new Error('CARD_QUOTA_HISTORY_CHANGED');
      error.failureClass = 'CARD_QUOTA_HISTORY_CHANGED'; throw error;
    }
  }
  return { historicalServiceGrantsPreserved: true, historicalServiceUsagePreserved: true, membershipPoliciesPreserved: true };
}
module.exports = { CARD_QUOTA_HISTORY_QUERIES, readCardQuotaHistoryState, assertCardQuotaHistoryPreserved };
