import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('payment request identity migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma',
      'migrations',
      '20260826114500_add_payment_request_identity',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds a stable unique provider order code and bounded local expiry facts', () => {
    expect(sql).toContain('"provider_order_code" BIGINT');
    expect(sql).toContain('"provider_expires_at" TIMESTAMPTZ(3)');
    expect(sql).toContain('"provider_request_started_at" TIMESTAMPTZ(3)');
    expect(sql).toContain('commerce_payment_attempts_provider_order_code_key');
    expect(sql).toContain('"provider_order_code" > 0');
    expect(sql).toContain('"provider_expires_at" > "created_at"');
  });

  it('keeps request identity, order code, and expiry immutable after insert', () => {
    expect(sql).toContain('NEW."provider_order_code"');
    expect(sql).toContain('OLD."provider_order_code"');
    expect(sql).toContain('NEW."provider_expires_at"');
    expect(sql).toContain("payment attempt request facts are immutable");
  });
});
