import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('payment receiving-account identity migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma',
      'migrations',
      '20260826170500_add_payment_receiving_account_hash',
      'migration.sql',
    ),
    'utf8',
  );

  it('stores only a bounded hash and requires it before PayOS can become pending', () => {
    expect(sql).toContain('"provider_receiving_account_hash" VARCHAR(128)');
    expect(sql).toContain('"status" = \'created\'');
    expect(sql).toContain('"provider_receiving_account_hash" IS NOT NULL');
  });

  it('makes an assigned receiving-account identity immutable', () => {
    expect(sql).toContain('OLD."provider_receiving_account_hash" IS NOT NULL');
    expect(sql).toContain('provider receiving account identity is immutable once assigned');
  });
});
