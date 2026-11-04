'use strict';
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const EXPECTED_MIGRATION_SHA256 = '8015F0029726ECFEA645158CF76299FF8BDFEC4E9A4908E3F2FAE6E411CEBF56';
function parseArguments(args) {
  const result = { action: 'preserve', minimum: '10000', maximum: '10000000' };
  const seen = new Set();
  const names = { '--action': 'action', '--minimum': 'minimum', '--maximum': 'maximum', '--expected-sha': 'expectedSha' };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (seen.has(name)) throw new Error('Invalid withdrawal arguments');
    seen.add(name);
    if (name === '--authorize-production-withdrawals') result.authorized = true;
    else if (names[name] && args[i + 1] !== undefined) result[names[name]] = args[++i];
    else throw new Error('Invalid withdrawal arguments');
  }
  if (!/^[a-f0-9]{40}$/.test(result.expectedSha || '') || !['preserve','enable','disable'].includes(result.action) ||
      !/^[1-9]\d{0,15}$/.test(result.minimum) || !/^[1-9]\d{0,15}$/.test(result.maximum) ||
      BigInt(result.minimum) > BigInt(result.maximum) || BigInt(result.maximum) > BigInt(Number.MAX_SAFE_INTEGER) ||
      (result.action !== 'preserve' && !result.authorized)) throw new Error('Withdrawal release authorization or limits invalid');
  return result;
}
async function configureVerifiedGdsWithdrawals(options, dependencies = {}) {
  options = parseArguments(['--action', options.action, '--minimum', options.minimum, '--maximum', options.maximum, '--expected-sha', options.expectedSha, ...(options.authorized ? ['--authorize-production-withdrawals'] : [])]);
  const environment = dependencies.environment || process.env;
  const exec = dependencies.execFile || execFileSync;
  const logger = dependencies.logger || console;
  const ClientConstructor = dependencies.ClientConstructor || Client;
  if (String(exec('git', ['rev-parse','--verify','HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })).trim() !== options.expectedSha) throw new Error('Withdrawal source revision mismatch');
  if (environment.NODE_ENV !== 'production' || environment.DEPLOYMENT_CLASS !== 'production' || !environment.DATABASE_URL) throw new Error('Withdrawal production classification invalid');
  const client = new ClientConstructor({ connectionString: environment.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 10000, application_name: 'eduai-gds-withdrawal-release' });
  let open = false;
  try {
    await client.connect(); await client.query('BEGIN'); open = true;
    const role = await client.query(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT pg_has_role(current_user,c.relowner,'MEMBER') AS runtime_safe FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.gds_withdrawal_settings'::regclass`);
    if (role.rows[0]?.runtime_safe !== true) throw new Error('Withdrawal runtime privileges invalid');
    const migration = await client.query(`SELECT checksum FROM public._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, ['20261104100000_add_gds_withdrawals']);
    if (migration.rows.length !== 1 || migration.rows[0].checksum.toUpperCase() !== EXPECTED_MIGRATION_SHA256) throw new Error('Withdrawal migration proof invalid');
    const current = await client.query("SELECT minimum_minor::text,maximum_minor::text,admission_enabled,processing_enabled,version FROM public.gds_withdrawal_settings WHERE id='global' FOR UPDATE");
    if (current.rows.length !== 1) throw new Error('Withdrawal settings missing');
    let state = current.rows[0];
    const target = options.action === 'enable' ? { minimum_minor: options.minimum, maximum_minor: options.maximum, admission_enabled: true, processing_enabled: true } : { minimum_minor: state.minimum_minor, maximum_minor: state.maximum_minor, admission_enabled: false, processing_enabled: state.processing_enabled };
    const changed = options.action !== 'preserve' && Object.keys(target).some(key => String(target[key]) !== String(state[key]));
    if (changed) {
      const updated = await client.query("UPDATE public.gds_withdrawal_settings SET minimum_minor=$1,maximum_minor=$2,admission_enabled=$3,processing_enabled=$4,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id='global' RETURNING minimum_minor::text,maximum_minor::text,admission_enabled,processing_enabled,version", [target.minimum_minor,target.maximum_minor,target.admission_enabled,target.processing_enabled]);
      state = updated.rows[0];
      await client.query("INSERT INTO public.audit_logs(actor_kind,actor_id,action,target_type,target_id,metadata_json) VALUES ('SYSTEM', NULL,'gds.withdrawal.settings.changed','gds_withdrawal_settings','global',$1::jsonb)", [JSON.stringify({ approval: 'OWNER_APPROVED_GDS_WITHDRAWAL_RELEASE', revision: options.expectedSha, ...state })]);
    }
    await client.query('COMMIT'); open = false;
    const result = { changed, minimumMinor: state.minimum_minor, maximumMinor: state.maximum_minor, admissionEnabled: state.admission_enabled, processingEnabled: state.processing_enabled, version: state.version };
    logger.log(JSON.stringify(result)); return result;
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
async function configureGdsWithdrawals(options, dependencies) {
  try { return await configureVerifiedGdsWithdrawals(options, dependencies); }
  catch { throw new Error('GDS withdrawal configuration failed closed'); }
}
if (require.main === module) {
  require('dotenv').config({ quiet: true, override: true });
  Promise.resolve().then(() => configureGdsWithdrawals(parseArguments(process.argv.slice(2)))).catch(() => { console.error('GDS withdrawal configuration failed closed'); process.exitCode = 1; });
}
module.exports = { parseArguments, configureGdsWithdrawals, EXPECTED_MIGRATION_SHA256 };
