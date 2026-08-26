import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('audit actor migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'prisma', 'migrations', '20260826170000_add_audit_actor_kind', 'migration.sql'),
    'utf8',
  );

  it('preserves user actors and permits only identity-free system/provider actors', () => {
    expect(sql).toContain('CREATE TYPE "audit_actor_kind" AS ENUM');
    expect(sql).toContain('ADD COLUMN "actor_kind"');
    expect(sql).toContain('ALTER COLUMN "actor_id" DROP NOT NULL');
    expect(sql).toContain('"actor_kind" = \'USER\' AND "actor_id" IS NOT NULL');
    expect(sql).toContain('"actor_kind" IN (\'SYSTEM\', \'PROVIDER\') AND "actor_id" IS NULL');
  });
});
