'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const runner = require('./run-production-migrations.cjs');
const row = (name, checksum) => ({ migration_name: name, checksum, finished_at: new Date(), rolled_back_at: null });
function fixture() {
  const base = [row(runner.EXPECTED_RECONCILIATION_MIGRATION, runner.EXPECTED_RECONCILIATION_MIGRATION_SHA256),
    row(runner.EXPECTED_BANK_TRANSFER_MIGRATION, runner.EXPECTED_BANK_TRANSFER_MIGRATION_SHA256),
    ...runner.REVIEWED_RECEIPT_MIGRATIONS.map(x => row(x.name, x.sha256)),
    ...runner.REVIEWED_REVENUE_MIGRATIONS.map(x => row(x.name, x.sha256))];
  const release = runner.REVIEWED_GDS_PLATFORM_MIGRATIONS.map(x => row(x.name, x.sha256));
  return { base, release, input: { allowAlreadyApplied: true, allowReviewedGdsPlatformMigrations: true,
    localMigrationNames: [...base, ...release].map(x => x.migration_name),
    localMigrationChecksums: Object.fromEntries([...base, ...release].map(x => [x.migration_name, x.checksum])), migrationRows: base } };
}
test('pins exactly seven reviewed GDS platform artifacts independently of the old financial release', () => {
  assert.equal(runner.REVIEWED_GDS_PLATFORM_MIGRATIONS?.length, 7);
  assert.equal(runner.REVIEWED_REVENUE_MIGRATIONS.length, 15);
  assert.deepEqual(runner.assertReviewedGdsPlatformMigrationFingerprints(join(__dirname, '..')),
    Object.fromEntries(runner.REVIEWED_GDS_PLATFORM_MIGRATIONS.map(x => [x.name, x.sha256])));
});
test('requires the separate GDS migration approval and does not accept receipt approval instead', () => {
  const { input } = fixture();
  for (const allowReviewedReceiptMigrations of [false, true]) assert.throws(() => runner.assertMigrationLedgerState({
    ...input, allowReviewedGdsPlatformMigrations: false, allowReviewedReceiptMigrations,
  }), { failureClass: 'MIGRATION_RELEASE_APPROVAL_REQUIRED' });
});
test('accepts only the reviewed GDS pending set and supports exact retry after partial completion', () => {
  const { input, base, release } = fixture();
  assert.deepEqual(runner.assertMigrationLedgerState(input).pendingMigrationNames, release.map(x => x.migration_name));
  for (let count = 1; count < release.length; count++) {
    assert.deepEqual(runner.assertMigrationLedgerState({ ...input, migrationRows: [...base, ...release.slice(0, count)] }).pendingMigrationNames,
      release.slice(count).map(x => x.migration_name));
  }
  assert.deepEqual(runner.assertMigrationLedgerState({ ...input, allowReviewedGdsPlatformMigrations: false, migrationRows: [...base, ...release] }).pendingMigrationNames, []);
});
test('rejects unknown artifacts, changed hashes, incomplete old financial release and ledger drift', () => {
  const { input, base, release } = fixture();
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, localMigrationNames: [...input.localMigrationNames, '20261112000000_unreviewed'] }));
  for (const migration of release) assert.throws(() => runner.assertMigrationLedgerState({ ...input,
    localMigrationChecksums: { ...input.localMigrationChecksums, [migration.migration_name]: '0'.repeat(64) } }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: base.slice(0, -1) }));
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: [...base, release[0], release[0]] }));
});
test('parses explicit release flags once, defaults closed and rejects unknown or duplicate arguments', () => {
  const flag = '--authorize-reviewed-gds-platform-migrations';
  assert.equal(runner.GDS_PLATFORM_MIGRATION_APPROVAL_ARGUMENT, flag);
  assert.deepEqual(runner.parseMigrationApprovalArguments([]), { allowReviewedReceiptMigrations: false, allowReviewedGdsPlatformMigrations: false, allowReviewedPointMigrations: false, allowReviewedCardServiceLimitMigrations: false });
  assert.deepEqual(runner.parseMigrationApprovalArguments([flag]), { allowReviewedReceiptMigrations: false, allowReviewedGdsPlatformMigrations: true, allowReviewedPointMigrations: false, allowReviewedCardServiceLimitMigrations: false });
  assert.deepEqual(runner.parseMigrationApprovalArguments(['--authorize-reviewed-receipt-migrations', flag]), { allowReviewedReceiptMigrations: true, allowReviewedGdsPlatformMigrations: true, allowReviewedPointMigrations: false, allowReviewedCardServiceLimitMigrations: false });
  for (const args of [[flag, flag], ['--unreviewed'], ['--authorize-reviewed-receipt-migrations', '--authorize-reviewed-receipt-migrations']]) {
    assert.throws(() => runner.parseMigrationApprovalArguments(args), { failureClass: 'MIGRATION_ARGUMENT_INVALID' });
  }
});
test('rejects GDS artifact drift between preflight snapshots', () => {
  assert.throws(() => runner.assertReconciliationPreflightStable({ gdsPlatformMigrationHashes: { approved: 'a' } },
    { gdsPlatformMigrationHashes: { approved: 'b' } }), { failureClass: 'MIGRATION_PREFLIGHT_STATE_DRIFT' });
});

test('rejects out-of-order GDS application and checksum drift in an already applied platform artifact', () => {
  const { input, base, release } = fixture();
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: [...base, release[1]] }),
    { failureClass: 'MIGRATION_LEDGER_STATE_DRIFT' });
  assert.throws(() => runner.assertMigrationLedgerState({ ...input, migrationRows: [...base, ...release],
    localMigrationChecksums: { ...input.localMigrationChecksums, [release[0].migration_name]: '0'.repeat(64) } }),
    { failureClass: 'MIGRATION_LEDGER_CHECKSUM_MISMATCH' });
});

test('passes explicit GDS approval through both preflights and rechecks hashes before apply', () => {
  const { readFileSync } = require('node:fs');
  const source = readFileSync(join(__dirname, 'run-production-migrations.cjs'), 'utf8');
  const initial = source.slice(source.indexOf("'INITIAL',"), source.indexOf("'REPEAT',"));
  const repeat = source.slice(source.indexOf("'REPEAT',"), source.indexOf("'STABILITY',"));
  assert.match(initial, /allowReviewedGdsPlatformMigrations/);
  assert.match(repeat, /allowReviewedGdsPlatformMigrations/);
  const beforeApply = source.indexOf('const gdsPlatformMigrationHashesBeforeApply = assertReviewedGdsPlatformMigrationFingerprints(rootDirectory);');
  assert.ok(beforeApply > source.indexOf("'STABILITY',"));
  assert.ok(beforeApply < source.indexOf('const migration = spawnSync('));
});
