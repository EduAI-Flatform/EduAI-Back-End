'use strict';
const { REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS } = require('./run-production-migrations.cjs');
const requiredTriggers = Object.freeze({
  membership_card_grant_provenance_immutable: 'service_entitlement_grants',
  membership_card_grant_validate: 'service_entitlement_grants',
  membership_card_policy_facts_immutable: 'platform_policy_revisions',
  service_entitlement_usage_validate: 'service_entitlement_usage',
  service_entitlement_usage_append_only: 'service_entitlement_usage',
});
async function verifyCardQuotaSchema(client) {
  const artifact = REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS[0];
  const ledger = await client.query(`SELECT checksum FROM public._prisma_migrations
    WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, [artifact.name]);
  if (ledger.rows.length !== 1 || ledger.rows[0].checksum?.toUpperCase() !== artifact.sha256) throw new Error('CARD_QUOTA_SCHEMA_NOT_READY');
  await client.query(`SELECT card_policy_revision_id,card_tier_code,card_source_digest,card_qualification FROM public.service_entitlement_grants LIMIT 0`);
  const triggers = await client.query(`SELECT t.tgname AS name,c.relname AS "table",t.tgenabled AS enabled FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND t.tgname=ANY($1::text[])`, [Object.keys(requiredTriggers)]);
  if (Object.entries(requiredTriggers).some(([name, table]) => !triggers.rows.some(row => row.name === name && row.table === table && ['O','A'].includes(row.enabled))))
    throw new Error('CARD_QUOTA_SCHEMA_NOT_READY');
  const constraints = await client.query(`SELECT conname AS name,convalidated AS valid FROM pg_catalog.pg_constraint
    WHERE conrelid='public.service_entitlement_grants'::regclass AND conname=ANY($1::text[])`,
  [['membership_card_policy_fk', 'membership_card_grant_provenance_check']]);
  if (constraints.rows.length !== 2 || constraints.rows.some(row => row.valid !== true)) throw new Error('CARD_QUOTA_SCHEMA_NOT_READY');
  return { cardQuotaSchemaReadable: true, cardQuotaGuardsEnabled: true };
}
async function main() {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try { await client.connect(); console.log(JSON.stringify(await verifyCardQuotaSchema(client))); }
  finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('CARD_QUOTA_SCHEMA_VERIFICATION_FAILED'); process.exitCode = 1; });
module.exports = { verifyCardQuotaSchema };
