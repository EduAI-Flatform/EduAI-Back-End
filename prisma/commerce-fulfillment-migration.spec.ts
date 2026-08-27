import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260827090000_add_atomic_commerce_fulfillment', 'migration.sql'),
  'utf8',
);

describe('Sprint 25 atomic Commerce fulfillment migration', () => {
  it('adds durable source-unique effects, membership terms, and notification outbox records', () => {
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "commerce_fulfillment_effects"');
    expect(sql).toContain('commerce_fulfillment_effects_line_effect_source_key');
    expect(sql).toContain('membership_subscriptions_source_order_line_id_key');
    expect(sql).toContain('membership_subscriptions_validate_purchase_source');
    expect(sql).toContain('purchased membership term snapshot is immutable');
    expect(sql).toContain('membership term must match its immutable purchased snapshot');
    expect(sql).toContain('CREATE TABLE "commerce_notification_outbox"');
    expect(sql).toContain('commerce_notification_outbox_event_key_key');
  });

  it('keeps financial effects immutable and notification delivery retryable', () => {
    expect(sql).toContain('commerce_fulfillment_effects_immutable');
    expect(sql).toContain('commerce_fulfillment_effects_order_line_match');
    expect(sql).toContain('commerce_notification_outbox_guard');
    expect(sql).toContain("OLD.\"status\" = 'pending' AND NEW.\"status\" = 'dispatched'");
  });
});
