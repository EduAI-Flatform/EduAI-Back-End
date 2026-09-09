import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');

const migrationsRoot = join(__dirname, 'migrations');

describe('Commerce lifecycle multi-transition guards on PostgreSQL', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      const migrationPath = join(migrationsRoot, directory, 'migration.sql');
      if (!existsSync(migrationPath)) continue;
      await db.exec(readFileSync(migrationPath, 'utf8'));
    }
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('validates lifecycle-event/entity binding immediately while entity evidence remains deferred', async () => {
    const trigger = await db.query<{ tgdeferrable: boolean; tginitdeferred: boolean }>(`
      SELECT tgdeferrable, tginitdeferred
      FROM pg_trigger
      WHERE tgname = 'commerce_lifecycle_events_validate_entity'
        AND NOT tgisinternal
    `);

    expect(trigger.rows).toEqual([
      { tgdeferrable: false, tginitdeferred: false },
    ]);
  });

  it('allows two valid fulfillment transitions for one confirmed order in a single transaction and still rejects forged evidence', async () => {
    const instructorId = '10000000-0000-4000-8000-000000000001';
    const buyerId = '10000000-0000-4000-8000-000000000002';
    const courseId = '10000000-0000-4000-8000-000000000003';
    const productId = '10000000-0000-4000-8000-000000000004';
    const orderId = '10000000-0000-4000-8000-000000000005';
    const lineId = '10000000-0000-4000-8000-000000000006';
    const startedOperationId = '10000000-0000-4000-8000-000000000007';
    const completedOperationId = '10000000-0000-4000-8000-000000000008';
    const forgedOperationId = '10000000-0000-4000-8000-000000000009';
    const attemptId = '10000000-0000-4000-8000-000000000010';
    const pendingOperationId = '10000000-0000-4000-8000-000000000011';
    const paymentEventId = '10000000-0000-4000-8000-000000000012';
    const settlementId = '10000000-0000-4000-8000-000000000013';
    const paidOperationId = '10000000-0000-4000-8000-000000000014';
    const confirmedOperationId = '10000000-0000-4000-8000-000000000015';

    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at)
      VALUES
        ('${instructorId}', 'lifecycle-instructor@example.test', 'hash', 'Instructor', CURRENT_TIMESTAMP),
        ('${buyerId}', 'lifecycle-buyer@example.test', 'hash', 'Buyer', CURRENT_TIMESTAMP);

      INSERT INTO courses (
        id, instructor_id, title, slug, level, status, visibility,
        price_amount_minor, price_currency, updated_at
      ) VALUES (
        '${courseId}', '${instructorId}', 'Lifecycle Course', 'lifecycle-course',
        'beginner', 'published', 'public', 1000, 'VND', CURRENT_TIMESTAMP
      );

      INSERT INTO commerce_products (id, type, course_id, seller_id, status, updated_at)
      VALUES ('${productId}', 'course', '${courseId}', '${instructorId}', 'draft', CURRENT_TIMESTAMP);
      UPDATE commerce_products
        SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = '${productId}';

      BEGIN;
      INSERT INTO commerce_orders (
        id, order_number, buyer_id, status, fulfillment_status,
        subtotal_amount_minor, discount_amount_minor, payable_amount_minor,
        currency, pricing_policy_version, updated_at
      ) VALUES (
        '${orderId}', 'ORD-LIFECYCLE-MULTI', '${buyerId}', 'pending_payment', 'not_started',
        1000, 0, 1000, 'VND', 'v1', CURRENT_TIMESTAMP
      );
      INSERT INTO commerce_order_lines (
        id, order_id, product_id, product_type, product_reference_id, seller_id,
        display_title, quantity, unit_list_price_amount_minor, subtotal_amount_minor,
        discount_amount_minor, final_amount_minor, currency
      ) VALUES (
        '${lineId}', '${orderId}', '${productId}', 'course', '${courseId}', '${instructorId}',
        'Lifecycle Course', 1, 1000, 1000, 0, 1000, 'VND'
      );
      COMMIT;

      INSERT INTO commerce_payment_attempts (
        id, order_id, provider, local_request_identity, provider_payment_identity,
        provider_receiving_account_hash, provider_order_code, provider_expires_at,
        provider_request_started_at, status, amount_minor, currency, updated_at
      ) VALUES (
        '${attemptId}', '${orderId}', 'payos',
        '10000000-0000-4000-8000-000000000016',
        'lifecycle-provider-payment', 'lifecycle-receiver-hash', 991001,
        CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP,
        'created', 1000, 'VND', CURRENT_TIMESTAMP
      );

      BEGIN;
      UPDATE commerce_payment_attempts
        SET status = 'pending', status_operation_id = '${pendingOperationId}', updated_at = CURRENT_TIMESTAMP
        WHERE id = '${attemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${attemptId}', 'created', 'pending', 'system', NULL, '${pendingOperationId}'
      );
      COMMIT;

      BEGIN;
      INSERT INTO commerce_payment_events (
        id, payment_attempt_id, provider, provider_event_identity,
        provider_payment_identity, provider_settlement_reference,
        amount_minor, currency, next_status
      ) VALUES (
        '${paymentEventId}', '${attemptId}', 'payos', 'lifecycle-provider-event',
        'lifecycle-provider-payment', 'lifecycle-provider-settlement',
        1000, 'VND', 'paid'
      );
      INSERT INTO commerce_settlements (
        id, order_id, payment_attempt_id, payment_event_id, kind, disposition,
        provider, provider_settlement_reference, amount_minor, currency, settled_at
      ) VALUES (
        '${settlementId}', '${orderId}', '${attemptId}', '${paymentEventId}',
        'provider_collection', 'matched', 'payos', 'lifecycle-provider-settlement',
        1000, 'VND', CURRENT_TIMESTAMP
      );
      UPDATE commerce_payment_attempts
        SET status = 'paid', status_operation_id = '${paidOperationId}',
            paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${attemptId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'payment', '${attemptId}', 'pending', 'paid', 'provider', NULL, '${paidOperationId}'
      );
      UPDATE commerce_orders
        SET status = 'confirmed', status_operation_id = '${confirmedOperationId}',
            confirmed_settlement_id = '${settlementId}', confirmed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${orderId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status, actor_kind, actor_id, operation_id
      ) VALUES (
        'order', '${orderId}', 'pending_payment', 'confirmed', 'provider', NULL, '${confirmedOperationId}'
      );
      COMMIT;

      BEGIN;
      UPDATE commerce_orders
        SET fulfillment_status = 'processing',
            fulfillment_operation_id = '${startedOperationId}',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${orderId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status,
        actor_kind, actor_id, operation_id, reason_code
      ) VALUES (
        'fulfillment', '${orderId}', 'not_started', 'processing',
        'system', NULL, '${startedOperationId}', 'FULFILLMENT_STARTED'
      );

      UPDATE commerce_orders
        SET fulfillment_status = 'fulfilled',
            fulfillment_operation_id = '${completedOperationId}',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = '${orderId}';
      INSERT INTO commerce_lifecycle_events (
        entity_type, entity_id, previous_status, next_status,
        actor_kind, actor_id, operation_id, reason_code
      ) VALUES (
        'fulfillment', '${orderId}', 'processing', 'fulfilled',
        'system', NULL, '${completedOperationId}', 'FULFILLMENT_COMPLETED'
      );
      COMMIT;
    `);

    const state = await db.query<{
      status: string;
      fulfillment_status: string;
      fulfillment_operation_id: string;
    }>(`
      SELECT status::text, fulfillment_status::text, fulfillment_operation_id::text
      FROM commerce_orders
      WHERE id = '${orderId}'
    `);
    expect(state.rows).toEqual([
      {
        status: 'confirmed',
        fulfillment_status: 'fulfilled',
        fulfillment_operation_id: completedOperationId,
      },
    ]);

    const events = await db.query<{
      previous_status: string;
      next_status: string;
      operation_id: string;
    }>(`
      SELECT previous_status, next_status, operation_id::text
      FROM commerce_lifecycle_events
      WHERE entity_type = 'fulfillment' AND entity_id = '${orderId}'
      ORDER BY occurred_at ASC, id ASC
    `);
    expect(events.rows).toEqual([
      {
        previous_status: 'not_started',
        next_status: 'processing',
        operation_id: startedOperationId,
      },
      {
        previous_status: 'processing',
        next_status: 'fulfilled',
        operation_id: completedOperationId,
      },
    ]);

    await expect(
      db.exec(`
        INSERT INTO commerce_lifecycle_events (
          entity_type, entity_id, previous_status, next_status,
          actor_kind, actor_id, operation_id, reason_code
        ) VALUES (
          'fulfillment', '${orderId}', 'processing', 'fulfilled',
          'system', NULL, '${forgedOperationId}', 'FORGED_EVENT'
        )
      `),
    ).rejects.toThrow(/current transition operation/);
  });
});
