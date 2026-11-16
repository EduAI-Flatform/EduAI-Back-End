'use strict';
const { REVIEWED_AUTH_SESSION_MIGRATIONS } = require('./run-production-migrations.cjs');
async function verifyAuthSessionSchema(client) {
  const artifact = REVIEWED_AUTH_SESSION_MIGRATIONS[0];
  const ledger = await client.query(`SELECT checksum FROM public._prisma_migrations
    WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, [artifact.name]);
  if (ledger.rows.length !== 1 || ledger.rows[0].checksum?.toUpperCase() !== artifact.sha256) throw new Error('AUTH_SESSION_SCHEMA_NOT_READY');
  await client.query('SELECT auth_revision FROM public.users LIMIT 0');
  await client.query('SELECT session_family_id FROM public.refresh_tokens LIMIT 0');
  const columns = await client.query(`SELECT c.relname AS "table",a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS "default" FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND
    ((c.relname='users' AND a.attname='auth_revision') OR (c.relname='refresh_tokens' AND a.attname='session_family_id'))`);
  if (!columns.rows.some(row => row.table === 'users' && row.name === 'auth_revision' && row.type === 'integer' && row.required === true && row.default === '0') ||
    !columns.rows.some(row => row.table === 'refresh_tokens' && row.name === 'session_family_id' && row.type === 'uuid' && row.required === false && row.default === null))
    throw new Error('AUTH_SESSION_SCHEMA_NOT_READY');
  const constraints = await client.query(`SELECT convalidated AS valid,pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_auth_revision_nonnegative'`);
  if (constraints.rows.length !== 1 || constraints.rows[0].valid !== true ||
    constraints.rows[0].definition !== 'CHECK ((auth_revision >= 0))') throw new Error('AUTH_SESSION_SCHEMA_NOT_READY');
  const indexes = await client.query(`SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
    pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i
    WHERE i.indrelid='public.refresh_tokens'::regclass AND i.indexrelid=to_regclass('public.refresh_tokens_user_id_session_family_id_idx')`);
  if (indexes.rows.length !== 1 || indexes.rows[0].valid !== true || indexes.rows[0].ready !== true || indexes.rows[0].unique !== false ||
    !indexes.rows[0].definition.endsWith('(user_id, session_family_id)')) throw new Error('AUTH_SESSION_SCHEMA_NOT_READY');
  const [privileges] = (await client.query(`SELECT
    has_column_privilege(current_user,'public.users','auth_revision','SELECT') AS "readRevision",
    has_column_privilege(current_user,'public.users','auth_revision','UPDATE') AS "updateRevision",
    has_column_privilege(current_user,'public.refresh_tokens','session_family_id','SELECT') AS "readFamily",
    has_column_privilege(current_user,'public.refresh_tokens','session_family_id','INSERT') AS "insertFamily"`)).rows;
  if (!['readRevision', 'updateRevision', 'readFamily', 'insertFamily'].every(key => privileges?.[key] === true))
    throw new Error('AUTH_SESSION_RUNTIME_PRIVILEGES_NOT_READY');
  return { authSessionSchemaReadable: true, authRevisionConstraintValidated: true, authSessionFamilyIndexReady: true, authSessionRuntimePrivilegesReady: true };
}
async function main() {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const result = await verifyAuthSessionSchema(client);
    await client.query('COMMIT'); console.log(JSON.stringify(result));
  } finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('AUTH_SESSION_SCHEMA_VERIFICATION_FAILED'); process.exitCode = 1; });
module.exports = { verifyAuthSessionSchema };
