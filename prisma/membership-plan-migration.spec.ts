import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = (directory: string): string =>
  readFileSync(
    join(process.cwd(), 'prisma', 'migrations', directory, 'migration.sql'),
    'utf8',
  );
const enumSql = migration('20260824160000_add_membership_product_type');
const sql = migration('20260824160100_add_versioned_membership_plans');

describe('Sprint 24 versioned membership plan migration', () => {
  it('is additive and supplies stable plans, immutable versions, and dynamic durations', () => {
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "membership_plans"');
    expect(sql).toContain('CREATE TABLE "membership_plan_versions"');
    expect(sql).toContain('CREATE TABLE "membership_duration_options"');
    expect(sql).toContain('membership_plan_versions_plan_id_version_number_key');
    expect(sql).toContain('membership_duration_options_version_id_months_key');
  });

  it('enforces VND BigInt pricing and exactly one fixed-price or discount mode', () => {
    expect(sql).toContain('BIGINT');
    expect(sql).toContain('membership_plan_versions_currency_check');
    expect(sql).toContain('membership_duration_options_pricing_mode_check');
    expect(sql).toContain('discount_percent" BETWEEN 0 AND 100');
    expect(sql).toContain('months" > 0');
  });

  it('protects published and archived terms at the database boundary', () => {
    expect(sql).toContain('membership_reject_immutable_version_change');
    expect(sql).toContain('membership_require_draft_version_insert');
    expect(sql).toContain('membership_guard_plan_change');
    expect(sql).toContain('membership_guard_duration_option_change');
    expect(sql).toContain('membership_plan_versions_immutable');
    expect(sql).toContain('membership_duration_options_immutable');
    expect(sql).toContain('A published membership version requires at least one duration option');
  });

  it('adds membership products without permitting ambiguous product references', () => {
    expect(enumSql).toContain("ALTER TYPE \"commerce_product_type\" ADD VALUE 'membership'");
    expect(sql).toContain('membership_plan_version_id');
    expect(sql).toContain('commerce_products_reference_check');
    expect(sql).toContain('NEW."membership_plan_version_id"');
  });
});
