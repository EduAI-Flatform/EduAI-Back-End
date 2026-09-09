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

  it('allows two valid fulfillment transitions for one order in a single transaction and still rejects forged evidence', async () => {
    const instructorId = '10000000-0000-4000-8000-000000000001';
    const buyerId = '10000000-0000-4000-8000-000000000002';
    const courseId = '10000000-0000-4000-8000-000000000003';
    const productId = '10000000-0000-4000-8000-000000000004';
    const orderId = '10000000-0000-4000-8000-000000000005';
    const lineId = '10000000-0000-4000-8000-000000000006';
    const startedOperationId = '10000000-0000-4000-8000-000000000007';
    const completedOperationId = '10000000-0000-4000-8000-000000000008';
    const forgedOperationId = '10000000-0000-4000-8000-000000000009';

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

    const state = await db.query<{ fulfillment_status: string; fulfillment_operation_id: string }>(`
      SELECT fulfillment_status::text, fulfillment_operation_id::text
      FROM commerce_orders
      WHERE id = '${orderId}'
    `);
    expect(state.rows).toEqual([
      {
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
