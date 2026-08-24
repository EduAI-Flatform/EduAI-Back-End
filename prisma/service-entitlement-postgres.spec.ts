import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');
const migrationsRoot = join(__dirname, 'migrations');

describe('Sprint 24 service entitlements on PostgreSQL', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      const path = join(migrationsRoot, directory, 'migration.sql');
      if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    }
  }, 120_000);

  afterAll(async () => db.close());

  it('rejects mismatched plan semantics and concurrent-style over-consumption at the database boundary', async () => {
    const admin = '20000000-0000-4000-8000-000000000001';
    const learner = '20000000-0000-4000-8000-000000000002';
    const plan = '20000000-0000-4000-8000-000000000003';
    const version = '20000000-0000-4000-8000-000000000004';
    const definition = '20000000-0000-4000-8000-000000000005';
    const grant = '20000000-0000-4000-8000-000000000006';
    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES
        ('${admin}', 'entitlement-admin@example.test', 'hash', 'Admin', CURRENT_TIMESTAMP),
        ('${learner}', 'entitlement-learner@example.test', 'hash', 'Learner', CURRENT_TIMESTAMP);
      INSERT INTO membership_plans (id, code, updated_at) VALUES ('${plan}', 'FLEX', CURRENT_TIMESTAMP);
      INSERT INTO membership_plan_versions (
        id, plan_id, version_number, display_name, base_monthly_price_amount_minor,
        currency, status, created_by_id, updated_at
      ) VALUES ('${version}', '${plan}', 1, 'Flexible', 0, 'VND', 'draft', '${admin}', CURRENT_TIMESTAMP);
      INSERT INTO membership_duration_options (version_id, months, price_amount_minor, display_order)
        VALUES ('${version}', 1, 0, 0);
      INSERT INTO service_entitlement_definitions (
        id, code, value_type, reset_period, display_name, created_by_id
      ) VALUES ('${definition}', 'AI_CHAT', 'metered', 'calendar_month', 'AI chat', '${admin}');
    `);
    await expect(db.exec(`
      INSERT INTO membership_plan_entitlements (
        version_id, definition_id, value_type, reset_period, boolean_value, created_by_id
      ) VALUES ('${version}', '${definition}', 'boolean', 'none', true, '${admin}')
    `)).rejects.toThrow(/semantics must match/);
    await db.exec(`
      INSERT INTO membership_plan_entitlements (
        version_id, definition_id, value_type, reset_period, quota, created_by_id
      ) VALUES ('${version}', '${definition}', 'metered', 'calendar_month', 1, '${admin}');
      INSERT INTO service_entitlement_grants (
        id, user_id, definition_id, source_type, source_id, value_type, reset_period,
        quota, starts_at, ends_at
      ) VALUES (
        '${grant}', '${learner}', '${definition}', 'MEMBERSHIP_TERM', 'term-1',
        'metered', 'calendar_month', 1, '2026-08-01', '2026-09-01'
      );
      INSERT INTO service_entitlement_usage (
        grant_id, user_id, operation_key_hash, request_hash, quantity,
        period_starts_at, period_ends_at, remaining_after, created_at
      ) VALUES (
        '${grant}', '${learner}', repeat('a', 64), repeat('b', 64), 1,
        '2026-08-01', '2026-09-01', 0, '2026-08-24'
      );
    `);
    await expect(db.exec(`
      INSERT INTO service_entitlement_usage (
        grant_id, user_id, operation_key_hash, request_hash, quantity,
        period_starts_at, period_ends_at, remaining_after, created_at
      ) VALUES (
        '${grant}', '${learner}', repeat('c', 64), repeat('d', 64), 1,
        '2026-08-01', '2026-09-01', 0, '2026-08-24'
      )
    `)).rejects.toThrow(/quota exhausted/);
    await expect(db.exec(`UPDATE service_entitlement_usage SET quantity = 2 WHERE grant_id = '${grant}'`))
      .rejects.toThrow(/append-only/);
  });

  it('freezes plan entitlement snapshots when their version is published', async () => {
    const version = '20000000-0000-4000-8000-000000000004';
    const admin = '20000000-0000-4000-8000-000000000001';
    await db.exec(`UPDATE membership_plan_versions SET status='published', published_by_id='${admin}', published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id='${version}'`);
    await expect(db.exec(`UPDATE membership_plan_entitlements SET quota=2 WHERE version_id='${version}'`))
      .rejects.toThrow(/published membership entitlements are immutable/);
  });
});
