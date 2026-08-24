import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260824170000_add_service_entitlements', 'migration.sql'),
  'utf8',
);

describe('Sprint 24 service entitlement migration', () => {
  it('adds typed definitions, immutable plan snapshots, grants, and append-only usage', () => {
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "service_entitlement_definitions"');
    expect(sql).toContain('CREATE TABLE "membership_plan_entitlements"');
    expect(sql).toContain('CREATE TABLE "service_entitlement_grants"');
    expect(sql).toContain('CREATE TABLE "service_entitlement_usage"');
    expect(sql).toContain('service_entitlement_usage_append_only');
  });

  it('enforces typed values, positive quotas, and stable source identities', () => {
    expect(sql).toContain('membership_plan_entitlements_value_check');
    expect(sql).toContain('service_entitlement_grants_value_check');
    expect(sql).toContain('service_entitlement_grants_source_key');
    expect(sql).toContain('service_entitlement_usage_user_id_operation_key_hash_key');
  });

  it('keeps published plan configuration immutable and usage self-consistent', () => {
    expect(sql).toContain('membership_guard_plan_entitlement_change');
    expect(sql).toContain('published membership entitlements are immutable');
    expect(sql).toContain('service_entitlement_validate_usage');
    expect(sql).toContain('service entitlement usage must match its owning grant');
  });
});
