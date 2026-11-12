'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const runner = require('./run-production-migrations.cjs');
const flag = '--authorize-reviewed-point-migrations';
function fixture() {
  const rows = [{ name: runner.EXPECTED_RECONCILIATION_MIGRATION, sha256: runner.EXPECTED_RECONCILIATION_MIGRATION_SHA256 },
    { name: runner.EXPECTED_BANK_TRANSFER_MIGRATION, sha256: runner.EXPECTED_BANK_TRANSFER_MIGRATION_SHA256 },
    ...runner.REVIEWED_RECEIPT_MIGRATIONS, ...runner.REVIEWED_REVENUE_MIGRATIONS, ...runner.REVIEWED_GDS_PLATFORM_MIGRATIONS];
  const points = runner.REVIEWED_POINT_MIGRATIONS;
  return { allowAlreadyApplied: true, localMigrationNames: [...rows, ...points].map(x => x.name),
    localMigrationChecksums: Object.fromEntries([...rows, ...points].map(x => [x.name, x.sha256])),
    migrationRows: rows.map(x => ({ migration_name: x.name, checksum: x.sha256, finished_at: new Date(), rolled_back_at: null })) };
}
test('pins the independently reviewed point artifact without extending older migration approvals', () => {
  assert.equal(runner.REVIEWED_POINT_MIGRATIONS?.length, 1);
  assert.deepEqual(runner.assertReviewedPointMigrationFingerprints(join(__dirname, '..')),
    Object.fromEntries(runner.REVIEWED_POINT_MIGRATIONS.map(x => [x.name, x.sha256])));
});
test('requires explicit point approval even when receipt and seven-platform approval are supplied', () => {
  const input = fixture();
  assert.throws(() => runner.assertMigrationLedgerState({ ...input,
    allowReviewedReceiptMigrations: true, allowReviewedGdsPlatformMigrations: true }), { failureClass: 'MIGRATION_RELEASE_APPROVAL_REQUIRED' });
  assert.deepEqual(runner.assertMigrationLedgerState({ ...input, allowReviewedPointMigrations: true }).pendingMigrationNames,
    ['20261112180000_activity_points']);
});
test('rejects unknown follow-up migrations, point artifact drift and missing platform prerequisites', () => {
  const input = { ...fixture(), allowReviewedPointMigrations: true };
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationNames: [...input.localMigrationNames, '20261113000000_unreviewed'] }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationChecksums: {
    ...input.localMigrationChecksums, '20261112180000_activity_points': '0'.repeat(64) } }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: input.migrationRows.slice(0, -1) }));
});
test('parses the separate point flag and rejects duplicate approvals', () => {
  assert.equal(runner.parseMigrationApprovalArguments([]).allowReviewedPointMigrations, false);
  assert.equal(runner.parseMigrationApprovalArguments([flag]).allowReviewedPointMigrations, true);
  assert.throws(() => runner.parseMigrationApprovalArguments([flag, flag]), { failureClass: 'MIGRATION_ARGUMENT_INVALID' });
});
test('detects reviewed point artifact drift between preflight snapshots', () => {
  assert.throws(() => runner.assertReconciliationPreflightStable({ pointMigrationHashes: { point: 'a' } },
    { pointMigrationHashes: { point: 'b' } }), { failureClass: 'MIGRATION_PREFLIGHT_STATE_DRIFT' });
});
test('detects point history drift between initial and repeat preflight', () => {
  assert.throws(() => runner.assertReconciliationPreflightStable({ pointHistory: { ledger: 'before' } },
    { pointHistory: { ledger: 'after' } }), { failureClass: 'MIGRATION_PREFLIGHT_STATE_DRIFT' });
});
test('deployment takes private backup before passing only the explicit point release flag', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
  assert.match(workflow, /authorize_point_schema_migrations:[\s\S]*?default: false/);
  const guard = workflow.indexOf('if [ "${{ inputs.authorize_point_schema_migrations }}" = "true" ]');
  const backup = workflow.indexOf('node scripts/backup-gds-platform.cjs', guard);
  const approval = workflow.indexOf('migration_args+=(--authorize-reviewed-point-migrations)', guard);
  const apply = workflow.indexOf('npm run prisma:migrate:production', guard);
  assert.ok(guard > 0 && backup > guard && approval > backup && apply > approval);
});
test('both preflights propagate approval and pin hashes immediately before migration', () => {
  const source = readFileSync(join(__dirname, 'run-production-migrations.cjs'), 'utf8');
  const initial = source.slice(source.indexOf("'INITIAL',"), source.indexOf("'REPEAT',"));
  const repeat = source.slice(source.indexOf("'REPEAT',"), source.indexOf("'STABILITY',"));
  assert.match(initial, /allowReviewedPointMigrations/);
  assert.match(repeat, /allowReviewedPointMigrations/);
  const finalCheck = source.indexOf('const pointMigrationHashesBeforeApply = assertReviewedPointMigrationFingerprints(rootDirectory);');
  assert.ok(finalCheck > source.indexOf("'STABILITY',") && finalCheck < source.indexOf('const migration = spawnSync('));
});
