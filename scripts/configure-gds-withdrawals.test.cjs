const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, configureGdsWithdrawals, EXPECTED_MIGRATION_SHA256 } = require('./configure-gds-withdrawals.cjs');

const revision = 'a'.repeat(40);
const env = { NODE_ENV: 'production', DEPLOYMENT_CLASS: 'production', DATABASE_URL: 'postgresql://runtime:synthetic@localhost/test' };
const options = action => parseArguments(['--action', action, '--expected-sha', revision, '--authorize-production-withdrawals']);
function fixture() {
  const state = { minimum_minor: '50000', maximum_minor: '10000000', admission_enabled: false, processing_enabled: false, version: 1 };
  const calls = []; const audits = []; const logs = [];
  let safeRole = true, checksum = EXPECTED_MIGRATION_SHA256, rejectAudit = false, nextState;
  class FakeClient {
    constructor(config) { assert.equal(config.connectionString, env.DATABASE_URL); assert.equal(config.query_timeout, 10000); }
    async connect() { calls.push('connect'); }
    async end() { calls.push('end'); }
    async query(sql, values) {
      calls.push(sql);
      if (sql.includes('runtime_safe')) return { rowCount: 1, rows: [{ runtime_safe: safeRole }] };
      if (sql.includes('FROM public._prisma_migrations')) return { rowCount: 1, rows: [{ checksum }] };
      if (sql.startsWith('SELECT minimum_minor')) return { rowCount: 1, rows: [{ ...state }] };
      if (sql.startsWith('UPDATE public.gds_withdrawal_settings')) {
        nextState = { minimum_minor: values[0], maximum_minor: values[1], admission_enabled: values[2], processing_enabled: values[3], version: state.version + 1 };
        return { rowCount: 1, rows: [nextState] };
      }
      if (sql.startsWith('INSERT INTO public.audit_logs')) {
        if (rejectAudit) throw new Error('secret-database-error');
        audits.push(JSON.parse(values[0])); return { rowCount: 1, rows: [] };
      }
      if (sql === 'COMMIT' && nextState) Object.assign(state, nextState);
      if (sql === 'ROLLBACK') { nextState = undefined; audits.length = 0; }
      return { rowCount: 0, rows: [] };
    }
  }
  const deps = { environment: env, ClientConstructor: FakeClient, execFile: (file, args) => {
    assert.equal(file, 'git'); assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD']); return revision + '\n';
  }, logger: { log: item => logs.push(item) } };
  return { state, calls, audits, logs, deps, setUnsafeRole: () => { safeRole = false; }, setBadChecksum: () => { checksum = 'b'.repeat(64); }, failAudit: () => { rejectAudit = true; } };
}

test('requires explicit authorization and exact revision for mutations; rejects malformed, duplicate and unknown args', () => {
  assert.equal(parseArguments(['--expected-sha', revision]).action, 'preserve');
  for (const args of [[], ['--action', 'enable', '--expected-sha', revision], ['--expected-sha', 'abc'], ['--expected-sha', revision, '--action', 'force'], ['--expected-sha', revision, '--unknown', 'x'], ['--expected-sha', revision, '--action', 'enable', '--action', 'disable'], ['--expected-sha', revision, '--minimum', '0'], ['--expected-sha', revision, '--minimum', '10000', '--maximum', '9999']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('enables the approved 10000–10000000 limits and audits the system action once', async () => {
  const f = fixture();
  const result = await configureGdsWithdrawals(options('enable'), f.deps);
  assert.deepEqual(f.state, { minimum_minor: '10000', maximum_minor: '10000000', admission_enabled: true, processing_enabled: true, version: 2 });
  assert.equal(result.changed, true); assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].approval, 'OWNER_APPROVED_GDS_WITHDRAWAL_RELEASE');
  const auditSql = f.calls.find(sql => sql.startsWith('INSERT INTO public.audit_logs'));
  assert.match(auditSql, /'SYSTEM', NULL/);
  assert.equal(JSON.stringify(f.logs).includes('synthetic'), false);
});

test('replaying enabled configuration neither changes version nor creates another audit', async () => {
  const f = fixture();
  await configureGdsWithdrawals(options('enable'), f.deps);
  const result = await configureGdsWithdrawals(options('enable'), f.deps);
  assert.equal(result.changed, false); assert.equal(f.state.version, 2); assert.equal(f.audits.length, 1);
});

test('disable stops admission while preserving processing and configured limits for recovery', async () => {
  const f = fixture(); f.state.admission_enabled = true; f.state.processing_enabled = true; f.state.minimum_minor = '20000';
  await configureGdsWithdrawals(options('disable'), f.deps);
  assert.equal(f.state.admission_enabled, false); assert.equal(f.state.processing_enabled, true);
  assert.equal(f.state.minimum_minor, '20000');
});

test('preserve reads verified configuration without audit or version churn', async () => {
  const f = fixture();
  const result = await configureGdsWithdrawals(parseArguments(['--expected-sha', revision]), f.deps);
  assert.equal(result.changed, false); assert.equal(result.minimumMinor, '50000'); assert.equal(f.state.version, 1); assert.equal(f.audits.length, 0);
});

test('fails closed for nonproduction, incorrect deployed revision, unsafe role or unreviewed migration', async () => {
  for (const mutate of [
    f => { f.deps.environment = { ...env, NODE_ENV: 'development' }; },
    f => { f.deps.execFile = () => 'c'.repeat(40); },
    f => f.setUnsafeRole(), f => f.setBadChecksum(),
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(configureGdsWithdrawals(options('enable'), f.deps), /failed closed/);
    assert.equal(f.state.admission_enabled, false); assert.equal(f.state.version, 1); assert.equal(f.audits.length, 0);
  }
});

test('rolls back settings when the mandatory system audit fails and never exposes the raw error', async () => {
  const f = fixture(); f.failAudit();
  await assert.rejects(configureGdsWithdrawals(options('enable'), f.deps), error => error.message === 'GDS withdrawal configuration failed closed');
  assert.equal(f.state.admission_enabled, false); assert.equal(f.state.version, 1);
  assert.ok(f.calls.includes('ROLLBACK')); assert.equal(f.calls.at(-1), 'end');
});
