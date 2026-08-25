import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260825090000_add_membership_checkout_lifecycle', 'migration.sql'),
  'utf8',
);
const snapshotSql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260825120000_support_membership_order_snapshots', 'migration.sql'),
  'utf8',
);

describe('Sprint 24 membership checkout migration', () => {
  it('is additive and preserves immutable order-linked checkout snapshots', () => {
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "membership_subscriptions"');
    expect(sql).toContain('CREATE TABLE "membership_checkout_intents"');
    expect(sql).toContain('membership_checkout_intents_order_id_key');
    expect(sql).toContain('membership_checkout_intents_window_check');
  });

  it('indexes learner lifecycle and pending-change lookup paths', () => {
    expect(sql).toContain('membership_subscriptions_user_id_status_expires_at_idx');
    expect(sql).toContain('membership_checkout_intents_user_id_created_at_idx');
  });

  it('extends the immutable Commerce source validator without weakening course checks', () => {
    expect(snapshotSql).toContain('CREATE OR REPLACE FUNCTION "commerce_validate_order_line_source"');
    expect(snapshotSql).toContain(`product_row."type" = 'course'`);
    expect(snapshotSql).toContain(`product_row."type" = 'membership'`);
    expect(snapshotSql).toContain('membership_checkout_intents');
    expect(snapshotSql).toContain('membership_plan_versions');
    expect(snapshotSql).toContain('membership_duration_options');
    expect(snapshotSql).toContain('NEW."membership_plan_version_id"');
    expect(snapshotSql).toContain('OLD."membership_plan_version_id"');
    expect(snapshotSql).toContain('order line must snapshot the active course title and current price');
    expect(snapshotSql).toContain('membership order line must match its immutable checkout intent');
    expect(snapshotSql).not.toContain('DROP TRIGGER');
  });
});
