import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');
const migrationsRoot = join(__dirname, 'migrations');

describe('Sprint 24 membership plans on PostgreSQL', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      const migrationPath = join(migrationsRoot, directory, 'migration.sql');
      if (existsSync(migrationPath)) {
        await db.exec(readFileSync(migrationPath, 'utf8'));
      }
    }
  }, 120_000);

  afterAll(async () => db.close());

  it('publishes immutable terms and accepts only an administrator-owned membership product', async () => {
    const adminId = '10000000-0000-4000-8000-000000000001';
    const roleId = '10000000-0000-4000-8000-000000000002';
    const planId = '10000000-0000-4000-8000-000000000003';
    const versionId = '10000000-0000-4000-8000-000000000004';
    const durationId = '10000000-0000-4000-8000-000000000005';

    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at)
      VALUES ('${adminId}', 'membership-admin@example.test', 'hash', 'Membership Admin', CURRENT_TIMESTAMP);
      INSERT INTO roles (id, name, description, updated_at)
      VALUES ('${roleId}', 'platform_admin', 'Administrator', CURRENT_TIMESTAMP);
      INSERT INTO user_roles (user_id, role_id) VALUES ('${adminId}', '${roleId}');
      INSERT INTO membership_plans (id, code, updated_at)
      VALUES ('${planId}', 'GOLD', CURRENT_TIMESTAMP);
      INSERT INTO membership_plan_versions (
        id, plan_id, version_number, display_name, base_monthly_price_amount_minor,
        currency, status, created_by_id, updated_at
      ) VALUES (
        '${versionId}', '${planId}', 1, 'Gold', 100001, 'VND', 'draft', '${adminId}', CURRENT_TIMESTAMP
      );
      INSERT INTO membership_duration_options (
        id, version_id, months, discount_percent, display_order
      ) VALUES ('${durationId}', '${versionId}', 3, 25, 0);
      UPDATE membership_plan_versions
        SET status = 'published', published_by_id = '${adminId}',
            published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${versionId}';
      INSERT INTO commerce_products (
        type, membership_plan_version_id, seller_id, status, updated_at
      ) VALUES ('membership', '${versionId}', '${adminId}', 'draft', CURRENT_TIMESTAMP);
    `);

    await expect(
      db.exec(`UPDATE membership_plan_versions SET display_name = 'Rewritten' WHERE id = '${versionId}'`),
    ).rejects.toThrow(/published membership versions are immutable/);
    await expect(
      db.exec(`UPDATE membership_plan_versions SET published_at = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE id = '${versionId}'`),
    ).rejects.toThrow(/published membership versions are immutable/);
    await expect(
      db.exec(`UPDATE membership_plans SET code = 'REWRITTEN' WHERE id = '${planId}'`),
    ).rejects.toThrow(/membership plan identities are immutable/);
    await expect(
      db.exec(`UPDATE membership_duration_options SET discount_percent = 10 WHERE id = '${durationId}'`),
    ).rejects.toThrow(/duration options are immutable/);
    await expect(
      db.exec(`DELETE FROM membership_plan_versions WHERE id = '${versionId}'`),
    ).rejects.toThrow(/published membership versions are immutable/);
    await expect(
      db.exec(`
        UPDATE membership_plans
          SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = '${planId}'
      `),
    ).rejects.toThrow(/membership plan products must be archived first/);
  });

  it('rejects ambiguous duration pricing and publication without a duration', async () => {
    const planId = '10000000-0000-4000-8000-000000000003';
    const adminId = '10000000-0000-4000-8000-000000000001';
    const versionId = '10000000-0000-4000-8000-000000000006';
    await db.exec(`
      INSERT INTO membership_plan_versions (
        id, plan_id, version_number, display_name, base_monthly_price_amount_minor,
        currency, status, created_by_id, updated_at
      ) VALUES (
        '${versionId}', '${planId}', 2, 'Gold Next', 100001, 'VND', 'draft', '${adminId}', CURRENT_TIMESTAMP
      );
    `);
    await expect(
      db.exec(`
        INSERT INTO membership_duration_options (
          version_id, months, price_amount_minor, discount_percent, display_order
        ) VALUES ('${versionId}', 6, 500000, 10, 0)
      `),
    ).rejects.toThrow(/membership_duration_options_pricing_mode_check/);
    await expect(
      db.exec(`
        UPDATE membership_plan_versions
          SET status = 'published', published_by_id = '${adminId}',
              published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = '${versionId}'
      `),
    ).rejects.toThrow(/requires at least one duration option/);
    await expect(
      db.exec(`
        INSERT INTO membership_plan_versions (
          plan_id, version_number, display_name, base_monthly_price_amount_minor,
          currency, status, created_by_id, published_by_id, published_at, updated_at
        ) VALUES (
          '${planId}', 3, 'Invalid Direct Publish', 0, 'VND', 'published',
          '${adminId}', '${adminId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow(/must be created as drafts/);
  });

  it('cannot publish a new version after its stable plan is archived', async () => {
    const planId = '10000000-0000-4000-8000-000000000007';
    const versionId = '10000000-0000-4000-8000-000000000008';
    const adminId = '10000000-0000-4000-8000-000000000001';
    await db.exec(`
      INSERT INTO membership_plans (id, code, updated_at)
      VALUES ('${planId}', 'ARCHIVED_PLAN', CURRENT_TIMESTAMP);
      INSERT INTO membership_plan_versions (
        id, plan_id, version_number, display_name, base_monthly_price_amount_minor,
        currency, status, created_by_id, updated_at
      ) VALUES (
        '${versionId}', '${planId}', 1, 'Archived Plan Draft', 0, 'VND',
        'draft', '${adminId}', CURRENT_TIMESTAMP
      );
      INSERT INTO membership_duration_options (version_id, months, price_amount_minor, display_order)
      VALUES ('${versionId}', 1, 0, 0);
      UPDATE membership_plans
        SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${planId}';
    `);
    await expect(
      db.exec(`
        UPDATE membership_plan_versions
          SET status = 'published', published_by_id = '${adminId}',
              published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = '${versionId}'
      `),
    ).rejects.toThrow(/only active membership plans can publish versions/);
  });

  it('commits a guarded membership checkout snapshot and idempotency result', async () => {
    const adminId = '10000000-0000-4000-8000-000000000001';
    const versionId = '10000000-0000-4000-8000-000000000004';
    const durationId = '10000000-0000-4000-8000-000000000005';
    const buyerId = '10000000-0000-4000-8000-000000000009';
    const orderId = '10000000-0000-4000-8000-000000000010';

    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at)
      VALUES ('${buyerId}', 'membership-buyer@example.test', 'hash', 'Membership Buyer', CURRENT_TIMESTAMP);
      BEGIN;
      UPDATE commerce_products
        SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE membership_plan_version_id = '${versionId}';
      INSERT INTO commerce_idempotency_records (
        actor_id, operation, key_hash, key_hash_version, request_hash,
        request_canonicalization_version, status, locked_until, updated_at
      ) VALUES (
        '${buyerId}', 'membership_checkout', repeat('a', 64), 1, repeat('b', 64),
        1, 'in_progress', CURRENT_TIMESTAMP + INTERVAL '30 seconds', CURRENT_TIMESTAMP
      );
      INSERT INTO commerce_orders (
        id, order_number, buyer_id, subtotal_amount_minor, discount_amount_minor,
        payable_amount_minor, currency, pricing_policy_version, updated_at
      ) VALUES (
        '${orderId}', 'EDU-M-PGLITE', '${buyerId}', 300003, 75001,
        225002, 'VND', 'MEMBERSHIP_V1', CURRENT_TIMESTAMP
      );
      INSERT INTO membership_checkout_intents (
        order_id, user_id, version_id, duration_option_id, action,
        starts_at, ends_at, activates_immediately
      ) VALUES (
        '${orderId}', '${buyerId}', '${versionId}', '${durationId}', 'purchase',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '3 months', true
      );
      INSERT INTO commerce_order_lines (
        order_id, product_id, product_type, product_reference_id, seller_id,
        display_title, quantity, unit_list_price_amount_minor, subtotal_amount_minor,
        discount_amount_minor, final_amount_minor, currency
      ) SELECT
        '${orderId}', id, 'membership', '${versionId}', '${adminId}',
        'Gold', 1, 300003, 300003, 75001, 225002, 'VND'
      FROM commerce_products WHERE membership_plan_version_id = '${versionId}';
      UPDATE commerce_idempotency_records
        SET status = 'completed', resource_type = 'commerce_order', resource_id = '${orderId}',
            completed_at = CURRENT_TIMESTAMP, locked_until = CURRENT_TIMESTAMP
        WHERE actor_id = '${buyerId}' AND operation = 'membership_checkout';
      COMMIT;
    `);

    const result = await db.query<{ line_count: number; intent_count: number }>(`
      SELECT
        (SELECT COUNT(*) FROM commerce_order_lines WHERE order_id = '${orderId}') AS line_count,
        (SELECT COUNT(*) FROM membership_checkout_intents WHERE order_id = '${orderId}') AS intent_count
    `);
    expect(result.rows[0]).toEqual({ line_count: 1, intent_count: 1 });
  });
});
