import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');

const migrationsRoot = join(__dirname, 'migrations');

describe('Sprint 23 commerce persistence on PostgreSQL', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      const migrationPath = join(migrationsRoot, directory, 'migration.sql');
      if (!existsSync(migrationPath)) continue;
      try {
        await db.exec(readFileSync(migrationPath, 'utf8'));
      } catch (error) {
        throw new Error(`Failed to apply ${directory}: ${String(error)}`);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('executes the migration and installs its deferred and immutable guards', async () => {
    const result = await db.query<{ trigger_name: string }>(`
      SELECT tgname AS trigger_name
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE 'commerce_%'
    `);
    const triggerNames = result.rows.map(({ trigger_name }) => trigger_name);

    expect(triggerNames).toContain('commerce_order_lines_immutable');
    expect(triggerNames).toContain('commerce_orders_validate_totals');
    expect(triggerNames).toContain('commerce_orders_require_lifecycle');
    expect(triggerNames).toContain('commerce_refunds_validate_recorded_bounds');
  });

  it('enforces ownership, immutable snapshots, totals, and non-destructive history', async () => {
    const instructorId = '00000000-0000-4000-8000-000000000001';
    const buyerId = '00000000-0000-4000-8000-000000000002';
    const courseId = '00000000-0000-4000-8000-000000000003';
    const productId = '00000000-0000-4000-8000-000000000004';
    const cartId = '00000000-0000-4000-8000-000000000005';
    const orderId = '00000000-0000-4000-8000-000000000006';
    const lineId = '00000000-0000-4000-8000-000000000007';

    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at)
      VALUES
        ('${instructorId}', 'commerce-instructor@example.test', 'hash', 'Instructor', CURRENT_TIMESTAMP),
        ('${buyerId}', 'commerce-buyer@example.test', 'hash', 'Buyer', CURRENT_TIMESTAMP);
      INSERT INTO courses (
        id, instructor_id, title, slug, level, status, visibility,
        price_amount_minor, price_currency, updated_at
      ) VALUES (
        '${courseId}', '${instructorId}', 'Immutable Course', 'immutable-course',
        'beginner', 'published', 'public', 1000, 'VND', CURRENT_TIMESTAMP
      );
      INSERT INTO commerce_products (id, type, course_id, seller_id, status, updated_at)
      VALUES ('${productId}', 'course', '${courseId}', '${instructorId}', 'draft', CURRENT_TIMESTAMP);
      UPDATE commerce_products SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = '${productId}';
      INSERT INTO commerce_carts (id, buyer_id, status, currency, updated_at)
      VALUES ('${cartId}', '${buyerId}', 'active', 'VND', CURRENT_TIMESTAMP);
      INSERT INTO commerce_cart_lines (cart_id, product_id, updated_at)
      VALUES ('${cartId}', '${productId}', CURRENT_TIMESTAMP);
      BEGIN;
      INSERT INTO commerce_orders (
        id, order_number, cart_id, buyer_id, status, fulfillment_status,
        subtotal_amount_minor, discount_amount_minor, payable_amount_minor,
        currency, pricing_policy_version, updated_at
      ) VALUES (
        '${orderId}', 'ORD-SPR23-002', '${cartId}', '${buyerId}', 'pending_payment', 'not_started',
        1000, 0, 1000, 'VND', 'v1', CURRENT_TIMESTAMP
      );
      INSERT INTO commerce_order_lines (
        id, order_id, product_id, product_type, product_reference_id, seller_id,
        display_title, quantity, unit_list_price_amount_minor, subtotal_amount_minor,
        discount_amount_minor, final_amount_minor, currency
      ) VALUES (
        '${lineId}', '${orderId}', '${productId}', 'course', '${courseId}', '${instructorId}',
        'Immutable Course', 1, 1000, 1000, 0, 1000, 'VND'
      );
      UPDATE commerce_carts
        SET status = 'converted', converted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${cartId}';
      COMMIT;
    `);

    await expect(
      db.exec(`UPDATE commerce_order_lines SET display_title = 'Rewritten' WHERE id = '${lineId}'`),
    ).rejects.toThrow(/immutable commerce record/);
    await expect(
      db.exec(`DELETE FROM commerce_orders WHERE id = '${orderId}'`),
    ).rejects.toThrow(/must be archived or transitioned/);
    await expect(
      db.exec(`
        INSERT INTO commerce_orders (
          order_number, cart_id, buyer_id, subtotal_amount_minor, discount_amount_minor,
          payable_amount_minor, currency, pricing_policy_version, updated_at
        ) VALUES ('ORD-WRONG-OWNER', '${cartId}', '${instructorId}', 1000, 0, 1000, 'VND', 'v1', CURRENT_TIMESTAMP)
      `),
    ).rejects.toThrow(/matching buyer and currency/);
  });

  it('scopes provider references and rejects settlement-free confirmation', async () => {
    const orderId = '00000000-0000-4000-8000-000000000006';
    const firstAttemptId = '00000000-0000-4000-8000-000000000010';
    const secondAttemptId = '00000000-0000-4000-8000-000000000011';

    await expect(
      db.exec(`
        UPDATE commerce_orders
          SET status = 'confirmed', status_operation_id = '00000000-0000-4000-8000-000000000008',
              confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = '${orderId}'
      `),
    ).rejects.toThrow(/commerce_orders_status_timestamp_check/);

    await db.exec(`
      BEGIN;
      INSERT INTO commerce_payment_attempts (
        id, order_id, provider, local_request_identity, provider_payment_identity,
        provider_order_code, provider_expires_at, provider_request_started_at,
        status, amount_minor, currency, updated_at
      ) VALUES (
        '${firstAttemptId}', '${orderId}', 'payos',
        '00000000-0000-4000-8000-000000000012',
        'provider-payment-1', 1001, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
        CURRENT_TIMESTAMP, 'created', 1000, 'VND', CURRENT_TIMESTAMP
      );
      COMMIT;
      BEGIN;
      UPDATE commerce_payment_attempts
        SET status = 'failed', status_operation_id = '00000000-0000-4000-8000-000000000014',
            closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${firstAttemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${firstAttemptId}', 'created', 'failed', 'system', NULL,
        '00000000-0000-4000-8000-000000000014'
      );
      COMMIT;
      BEGIN;
      INSERT INTO commerce_payment_attempts (
        id, order_id, provider, local_request_identity, provider_payment_identity,
        status, amount_minor, currency, updated_at
      ) VALUES (
        '${secondAttemptId}', '${orderId}', 'other-provider',
        '00000000-0000-4000-8000-000000000015',
        'provider-payment-1', 'created', 1000, 'VND', CURRENT_TIMESTAMP
      );
      COMMIT;
    `);

    await db.exec(`
      BEGIN;
      UPDATE commerce_payment_attempts
        SET status = 'failed', status_operation_id = '00000000-0000-4000-8000-000000000018',
            closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${secondAttemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${secondAttemptId}', 'created', 'failed', 'system', NULL,
        '00000000-0000-4000-8000-000000000018'
      );
      COMMIT;
    `);

    await expect(
      db.exec(`
        INSERT INTO commerce_payment_attempts (
          order_id, provider, local_request_identity, provider_payment_identity,
          provider_order_code, provider_expires_at, provider_request_started_at,
          status, amount_minor, currency, updated_at
        ) VALUES (
          '${orderId}', 'payos', '00000000-0000-4000-8000-000000000017',
          'provider-payment-1', 1002, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
          CURRENT_TIMESTAMP, 'created', 1000, 'VND', CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow(/commerce_payment_attempts_provider_payment_identity_key/);

    await expect(
      db.exec(`
        INSERT INTO commerce_lifecycle_events (
          entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
        ) VALUES (
          'payment', '${firstAttemptId}', 'created', 'failed', 'system', NULL,
          '00000000-0000-4000-8000-000000000019'
        )
      `),
    ).rejects.toThrow(/current transition operation/);

    const paidAttemptId = '00000000-0000-4000-8000-000000000020';
    const paymentEventId = '00000000-0000-4000-8000-000000000021';
    const settlementId = '00000000-0000-4000-8000-000000000022';
    await db.exec(`
      INSERT INTO commerce_payment_attempts (
        id, order_id, provider, local_request_identity, provider_payment_identity,
        provider_order_code, provider_expires_at, provider_request_started_at,
        status, amount_minor, currency, updated_at
      ) VALUES (
        '${paidAttemptId}', '${orderId}', 'payos',
        '00000000-0000-4000-8000-000000000023',
        'provider-payment-2', 1003, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
        CURRENT_TIMESTAMP, 'created', 1000, 'VND', CURRENT_TIMESTAMP
      );
      BEGIN;
      UPDATE commerce_payment_attempts
        SET status = 'pending', status_operation_id = '00000000-0000-4000-8000-000000000024',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${paidAttemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${paidAttemptId}', 'created', 'pending', 'system', NULL,
        '00000000-0000-4000-8000-000000000024'
      );
      COMMIT;
      BEGIN;
      INSERT INTO commerce_payment_events (
        id, payment_attempt_id, provider, provider_event_identity, provider_payment_identity,
        provider_settlement_reference, amount_minor, currency, next_status
      ) VALUES (
        '${paymentEventId}', '${paidAttemptId}', 'payos', 'provider-event-1', 'provider-payment-2',
        'provider-settlement-1', 1000, 'VND', 'paid'
      );
      INSERT INTO commerce_settlements (
        id, order_id, payment_attempt_id, payment_event_id, kind, disposition, provider,
        provider_settlement_reference, amount_minor, currency, settled_at
      ) VALUES (
        '${settlementId}', '${orderId}', '${paidAttemptId}', '${paymentEventId}',
        'provider_collection', 'matched', 'payos', 'provider-settlement-1',
        1000, 'VND', CURRENT_TIMESTAMP
      );
      UPDATE commerce_payment_attempts
        SET status = 'paid', status_operation_id = '00000000-0000-4000-8000-000000000025',
            paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${paidAttemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${paidAttemptId}', 'pending', 'paid', 'provider', NULL,
        '00000000-0000-4000-8000-000000000025'
      );
      UPDATE commerce_orders
        SET status = 'confirmed', status_operation_id = '00000000-0000-4000-8000-000000000026',
            confirmed_settlement_id = '${settlementId}', confirmed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${orderId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'order', '${orderId}', 'pending_payment', 'confirmed', 'provider', NULL,
        '00000000-0000-4000-8000-000000000026'
      );
      COMMIT;
    `);

    const state = await db.query<{ order_status: string; attempt_status: string }>(`
      SELECT orders.status::text AS order_status, attempts.status::text AS attempt_status
      FROM commerce_orders orders
      JOIN commerce_payment_attempts attempts ON attempts.id = '${paidAttemptId}'
      WHERE orders.id = '${orderId}'
    `);
    expect(state.rows).toEqual([{ order_status: 'confirmed', attempt_status: 'paid' }]);
  });
});
