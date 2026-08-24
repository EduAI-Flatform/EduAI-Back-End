import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationDirectory = '20260824013000_add_commerce_persistence';
const readMigrationFile = (fileName: string): string =>
  readFileSync(
    join(process.cwd(), 'prisma', 'migrations', migrationDirectory, fileName),
    'utf8',
  );

describe('Sprint 23 commerce persistence migration', () => {
  it('is additive and preserves the existing Course price columns', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).not.toMatch(/ALTER TABLE "courses".*price_amount_minor/is);
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "commerce_products"');
    expect(sql).toContain('CREATE TABLE "commerce_orders"');
    expect(sql).toContain('CREATE TABLE "commerce_payment_attempts"');
    expect(sql).toContain('CREATE TABLE "commerce_settlements"');
    expect(sql).toContain('CREATE TABLE "commerce_refunds"');
  });

  it('enforces VND integer totals and immutable order snapshots', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).toContain('BIGINT');
    expect(sql).toContain('CHECK ("currency" = \'VND\')');
    expect(sql).toContain('commerce_orders_totals_check');
    expect(sql).toContain('commerce_order_lines_totals_check');
    expect(sql).toContain('commerce_validate_order_totals');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('commerce_reject_immutable_change');
    expect(sql).toContain('commerce_order_lines_immutable');
  });

  it('scopes provider references and represents open-attempt and internal-settlement uniqueness', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).toContain('commerce_payment_attempts_provider_payment_identity_key');
    expect(sql).toContain('commerce_payment_events_provider_event_identity_key');
    expect(sql).toContain('commerce_settlements_provider_reference_key');
    expect(sql).toContain('commerce_payment_attempts_one_open_per_order_idx');
    expect(sql).toContain('commerce_settlements_one_internal_per_order_idx');
    expect(sql).toContain('WHERE "status" IN (\'created\', \'pending\')');
  });

  it('enforces reservation identity, refund allocation, and non-destructive history', () => {
    const sql = readMigrationFile('migration.sql');

    expect(sql).toContain('commerce_reservations_source_check');
    expect(sql).toContain('commerce_validate_refund_totals');
    expect(sql).toContain('commerce_validate_recorded_refund_bounds');
    expect(sql).toContain('commerce_reject_financial_delete');
    expect(sql).toContain('commerce_lifecycle_events_immutable');
    expect(sql).toContain('commerce_payment_events_immutable');
  });

  it('documents a forward-only application rollback that preserves financial records', () => {
    const recovery = readMigrationFile('README.md');

    expect(recovery).toContain('Forward-only');
    expect(recovery).toContain('must not drop');
    expect(recovery).toContain('feature flags');
    expect(recovery).toContain('reconciliation');
  });
});
