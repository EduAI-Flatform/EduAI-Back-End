'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const runner = require('./run-production-migrations.cjs');
const flag = '--authorize-reviewed-card-service-limit-migrations';
function fixture() {
  const old = [{ name: runner.EXPECTED_RECONCILIATION_MIGRATION, sha256: runner.EXPECTED_RECONCILIATION_MIGRATION_SHA256 },
    { name: runner.EXPECTED_BANK_TRANSFER_MIGRATION, sha256: runner.EXPECTED_BANK_TRANSFER_MIGRATION_SHA256 },
    ...runner.REVIEWED_RECEIPT_MIGRATIONS, ...runner.REVIEWED_REVENUE_MIGRATIONS,
    ...runner.REVIEWED_GDS_PLATFORM_MIGRATIONS, ...runner.REVIEWED_POINT_MIGRATIONS];
  const all = [...old, ...(runner.REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS ?? [])];
  return { allowAlreadyApplied: true, localMigrationNames: all.map(row => row.name),
    localMigrationChecksums: Object.fromEntries(all.map(row => [row.name, row.sha256])),
    migrationRows: old.map(row => ({ migration_name: row.name, checksum: row.sha256, finished_at: new Date(), rolled_back_at: null })) };
}
test('pins card provenance independently from earlier release approvals', () => {
  assert.equal(runner.REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS?.length, 1);
  assert.deepEqual(runner.assertReviewedCardServiceLimitMigrationFingerprints(join(__dirname, '..')),
    Object.fromEntries(runner.REVIEWED_CARD_SERVICE_LIMIT_MIGRATIONS.map(row => [row.name, row.sha256])));
});
test('older approvals cannot apply card provenance; a separate approval admits only the pinned artifact', () => {
  const input = fixture();
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, allowReviewedReceiptMigrations: true,
    allowReviewedGdsPlatformMigrations: true, allowReviewedPointMigrations: true }), { failureClass: 'MIGRATION_RELEASE_APPROVAL_REQUIRED' });
  assert.deepEqual(runner.assertMigrationLedgerState({ ...input, allowReviewedCardServiceLimitMigrations: true }).pendingMigrationNames,
    ['20261113100000_card_service_limit_provenance']);
});
test('rejects changed artifacts, missing prerequisites and unknown follow-up migrations', () => {
  const input = { ...fixture(), allowReviewedCardServiceLimitMigrations: true };
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationChecksums: {
    ...input.localMigrationChecksums, '20261113100000_card_service_limit_provenance': '0'.repeat(64) } }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: input.migrationRows.slice(0, -1) }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationNames: [...input.localMigrationNames, '20261114000000_unknown'] }));
});
test('requires an explicit distinct flag and rejects duplicates', () => {
  assert.equal(runner.parseMigrationApprovalArguments([]).allowReviewedCardServiceLimitMigrations, false);
  assert.equal(runner.parseMigrationApprovalArguments([flag]).allowReviewedCardServiceLimitMigrations, true);
  assert.throws(() => runner.parseMigrationApprovalArguments([flag, flag]));
});
test('repeat preflight rejects card artifact or entitlement history drift', () => {
  for (const field of ['cardServiceLimitMigrationHashes', 'cardQuotaHistory']) {
    assert.throws(() => runner.assertReconciliationPreflightStable({ [field]: { value: 'before' } },
      { [field]: { value: 'after' } }), { failureClass: 'MIGRATION_PREFLIGHT_STATE_DRIFT' });
  }
});
test('controlled deployment backs up before card migration and verifies schema before restart', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
  assert.match(workflow, /authorize_card_service_limit_schema_migrations:[\s\S]*?default: false/);
  const guard = workflow.indexOf('if [ "${{ inputs.authorize_card_service_limit_schema_migrations }}" = "true" ]');
  const backup = workflow.indexOf('node scripts/backup-gds-platform.cjs', guard);
  const approval = workflow.indexOf('migration_args+=(--authorize-reviewed-card-service-limit-migrations)', guard);
  const apply = workflow.indexOf('npm run prisma:migrate:production', guard);
  const verify = workflow.indexOf('node scripts/verify-card-quota-schema.cjs', apply);
  const restart = workflow.indexOf('npm run process:restart:production', verify);
  assert.ok(guard > 0 && backup > guard && approval > backup && apply > approval && verify > apply && restart > verify);
});
test('both preflights capture approval, card history and point history; final check pins the card artifact', () => {
  const source = readFileSync(join(__dirname, 'run-production-migrations.cjs'), 'utf8');
  const initial = source.slice(source.indexOf("'INITIAL',"), source.indexOf("'REPEAT',"));
  const repeat = source.slice(source.indexOf("'REPEAT',"), source.indexOf("'STABILITY',"));
  assert.match(initial, /allowReviewedCardServiceLimitMigrations/);
  assert.match(repeat, /allowReviewedCardServiceLimitMigrations/);
  assert.match(source, /cardQuotaHistory: allowReviewedCardServiceLimitMigrations \? await readCardQuotaHistoryState\(client\)/);
  assert.match(source, /allowReviewedPointMigrations \|\| allowReviewedCardServiceLimitMigrations \? await readPointHistoryState/);
  const check = source.indexOf('const cardServiceLimitMigrationHashesBeforeApply = assertReviewedCardServiceLimitMigrationFingerprints(rootDirectory);');
  assert.ok(check > source.indexOf("'STABILITY',") && check < source.indexOf('const migration = spawnSync('));
});
