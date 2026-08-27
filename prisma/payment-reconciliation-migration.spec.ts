import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260827143000_add_payment_reconciliation_review',
    'migration.sql',
  ),
  'utf8',
);

describe('Sprint 25 payment reconciliation migration', () => {
  it('keeps operational review identity separate from repeat collection identity', () => {
    expect(sql).toContain('ADD COLUMN "source_key" VARCHAR(160)');
    expect(sql).toContain('commerce_reconciliation_cases_source_key_key');
    expect(sql).not.toContain('payment_attempt_id_kind_key');
  });

  it('allows attempt-backed review without weakening settlement-backed validation', () => {
    expect(sql).toContain('"kind" IN (\'duplicate_collection\', \'late_payment\') AND "settlement_id" IS NOT NULL');
    expect(sql).toContain('reconciliation case does not match settlement disposition');
    expect(sql).toContain('reconciliation case does not match payment attempt');
  });

  it('preserves monotonic evidence and restricts financial resolution', () => {
    expect(sql).toContain('reconciliation observation evidence is monotonic');
    expect(sql).toContain('financial collection review cannot be acknowledged away');
    expect(sql).toContain('retry resolution requires fulfilled order evidence');
  });
});
