const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { REVIEWED_REVENUE_MIGRATIONS, REVIEWED_RECEIPT_MIGRATIONS, EXPECTED_RECONCILIATION_MIGRATION, EXPECTED_RECONCILIATION_MIGRATION_SHA256, EXPECTED_BANK_TRANSFER_MIGRATION, EXPECTED_BANK_TRANSFER_MIGRATION_SHA256, assertReviewedRevenueMigrationFingerprints, assertMigrationLedgerState } = require('./run-production-migrations.cjs');
const row = (name, checksum) => ({ migration_name: name, checksum, finished_at: new Date(), rolled_back_at: null });
function fixture() {
  const base = [row(EXPECTED_RECONCILIATION_MIGRATION, EXPECTED_RECONCILIATION_MIGRATION_SHA256), row(EXPECTED_BANK_TRANSFER_MIGRATION, EXPECTED_BANK_TRANSFER_MIGRATION_SHA256), ...REVIEWED_RECEIPT_MIGRATIONS.map(x => row(x.name, x.sha256))];
  const release = REVIEWED_REVENUE_MIGRATIONS.map(x => row(x.name, x.sha256));
  return { base, release, input: { allowAlreadyApplied: true, localMigrationNames: [...base, ...release].map(x => x.migration_name), localMigrationChecksums: Object.fromEntries([...base, ...release].map(x => [x.migration_name, x.checksum])), migrationRows: base } };
}
test('pins all thirteen owner-reviewed GDS/revenue/withdrawal upgrade artifacts', () => {
  assert.equal(REVIEWED_REVENUE_MIGRATIONS.length, 13);
  assert.deepEqual(assertReviewedRevenueMigrationFingerprints(join(__dirname, '..')), Object.fromEntries(REVIEWED_REVENUE_MIGRATIONS.map(x => [x.name, x.sha256])));
});

test('accepts only the exact approved withdrawal artifact after the existing release', () => {
  const { input, base, release } = fixture();
  const withdrawal = release.find(x => x.migration_name === '20261104100000_add_gds_withdrawals');
  input.migrationRows = [...base, ...release.filter(x => x !== withdrawal)];
  assert.deepEqual(assertMigrationLedgerState(input).pendingMigrationNames, [withdrawal.migration_name]);
  assert.throws(() => assertMigrationLedgerState({ ...input, localMigrationChecksums: { ...input.localMigrationChecksums, [withdrawal.migration_name]: '0'.repeat(64) } }));
});
test('accepts only the reviewed release after the receipt baseline is applied', () => {
  const { input, release } = fixture();
  assert.deepEqual(assertMigrationLedgerState(input).pendingMigrationNames, release.map(x => x.migration_name));
});
test('supports revenue pending after later GDS migrations were already applied', () => {
  const { input, release, base } = fixture();
  const revenue = release.find(x => x.migration_name.endsWith('_revenue_sharing'));
  input.migrationRows = [...base, ...release.filter(x => x !== revenue)];
  assert.deepEqual(assertMigrationLedgerState(input).pendingMigrationNames, [revenue.migration_name]);
});
test('rejects unknown future migrations and missing legacy receipt approval', () => {
  const { input } = fixture();
  assert.throws(() => assertMigrationLedgerState({ ...input, localMigrationNames: [...input.localMigrationNames, '20261104000000_unreviewed'] }));
  assert.throws(() => assertMigrationLedgerState({ ...input, migrationRows: input.migrationRows.slice(0, -1) }));
});
test('rejects changed release SQL checksums', () => {
  const { input, release } = fixture();
  const name = release[0].migration_name;
  assert.throws(() => assertMigrationLedgerState({ ...input, localMigrationChecksums: { ...input.localMigrationChecksums, [name]: '0'.repeat(64) } }));
});
