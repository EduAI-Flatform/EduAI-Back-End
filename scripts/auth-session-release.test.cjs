'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const runner = require('./run-production-migrations.cjs');
const flag = '--authorize-reviewed-auth-session-migrations';
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
function fixture() {
  const old = [{ name: runner.EXPECTED_RECONCILIATION_MIGRATION, sha256: runner.EXPECTED_RECONCILIATION_MIGRATION_SHA256 },
    { name: runner.EXPECTED_BANK_TRANSFER_MIGRATION, sha256: runner.EXPECTED_BANK_TRANSFER_MIGRATION_SHA256 },
    ...runner.REVIEWED_RECEIPT_MIGRATIONS, ...runner.REVIEWED_REVENUE_MIGRATIONS, ...runner.REVIEWED_GDS_PLATFORM_MIGRATIONS,
    ...runner.REVIEWED_POINT_MIGRATIONS, ...runner.REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS];
  const all = [...old, ...runner.REVIEWED_AUTH_SESSION_MIGRATIONS];
  return { allowAlreadyApplied: true, localMigrationNames: all.map(row => row.name),
    localMigrationChecksums: Object.fromEntries(all.map(row => [row.name, row.sha256])),
    migrationRows: old.map(row => ({ migration_name: row.name, checksum: row.sha256, finished_at: new Date(), rolled_back_at: null })) };
}

test('auth session schema defaults closed and requires its own explicit release argument', () => {
  assert.equal(runner.parseMigrationApprovalArguments([]).allowReviewedAuthSessionMigrations, false);
  assert.equal(runner.parseMigrationApprovalArguments([flag]).allowReviewedAuthSessionMigrations, true);
});
test('duplicate and unknown auth release arguments remain rejected', () => {
  for (const args of [[flag, flag], [flag, '--unreviewed']]) {
    assert.throws(() => runner.parseMigrationApprovalArguments(args), { failureClass: 'MIGRATION_ARGUMENT_INVALID' });
  }
});
test('pins exactly one additive auth artifact', () => {
  assert.equal(runner.REVIEWED_AUTH_SESSION_MIGRATIONS.length, 1);
  assert.deepEqual(runner.assertReviewedAuthSessionMigrationFingerprints(join(__dirname, '..')),
    Object.fromEntries(runner.REVIEWED_AUTH_SESSION_MIGRATIONS.map(row => [row.name, row.sha256])));
});
test('older flags cannot authorize auth; only the exact approved suffix can apply', () => {
  const input = fixture();
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, allowReviewedReceiptMigrations: true,
    allowReviewedGdsPlatformMigrations: true, allowReviewedPointMigrations: true, allowReviewedCardServiceLimitMigrations: true }),
  { failureClass: 'MIGRATION_RELEASE_APPROVAL_REQUIRED' });
  assert.deepEqual(runner.assertMigrationLedgerState({ ...input, allowReviewedAuthSessionMigrations: true }).pendingMigrationNames,
    ['20261116090000_auth_session_v2_foundation']);
  const applied = [...input.migrationRows, ...runner.REVIEWED_AUTH_SESSION_MIGRATIONS.map(row => ({
    migration_name: row.name, checksum: row.sha256, finished_at: new Date(), rolled_back_at: null }))];
  assert.deepEqual(runner.assertMigrationLedgerState({ ...input, migrationRows: applied }).pendingMigrationNames, []);
});
test('rejects altered artifacts, unknown suffixes and missing prior schema', () => {
  const input = { ...fixture(), allowReviewedAuthSessionMigrations: true };
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationNames: [...input.localMigrationNames, '20261117000000_unreviewed'] }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: input.migrationRows.slice(0, -1) }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationChecksums: {
    ...input.localMigrationChecksums, '20261116090000_auth_session_v2_foundation': '0'.repeat(64) } }));
  assert.throws(() => runner.assertReconciliationPreflightStable({ authSessionMigrationHashes: { a: 'before' } },
    { authSessionMigrationHashes: { a: 'after' } }), { failureClass: 'MIGRATION_PREFLIGHT_STATE_DRIFT' });
});
test('deployment requires backup and runtime verification before restart', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
  assert.match(workflow, /authorize_auth_session_schema_migrations:[\s\S]*?default: false/);
  const guard = workflow.indexOf('if [ "${{ inputs.authorize_auth_session_schema_migrations }}" = "true" ]');
  const backup = workflow.indexOf('node scripts/backup-gds-platform.cjs', guard);
  const approval = workflow.indexOf('migration_args+=(--authorize-reviewed-auth-session-migrations)', backup);
  const apply = workflow.indexOf('npm run prisma:migrate:production', approval);
  const verify = workflow.indexOf('node scripts/verify-auth-session-schema.cjs', apply);
  const restart = workflow.indexOf('npm run process:restart:production', verify);
  assert.ok(guard > 0 && backup > guard && approval > backup && apply > approval && verify > apply && restart > verify);
  const source = readFileSync(join(__dirname, 'run-production-migrations.cjs'), 'utf8');
  assert.match(source.slice(source.indexOf("'INITIAL',"), source.indexOf("'REPEAT',")), /allowReviewedAuthSessionMigrations/);
  assert.match(source.slice(source.indexOf("'REPEAT',"), source.indexOf("'STABILITY',")), /allowReviewedAuthSessionMigrations/);
});
