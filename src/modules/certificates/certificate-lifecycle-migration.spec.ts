import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('certificate lifecycle migration', () => {
  it('preserves codes and limits uniqueness to active certificates', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260812080000_add_certificate_lifecycle/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('ADD COLUMN "status"');
    expect(sql).toContain('ADD COLUMN "revoked_at"');
    expect(sql).toContain('ADD COLUMN "revocation_reason"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "certificates_user_id_course_id_key"');
    expect(sql).toContain('WHERE "status" = \'active\'');
    expect(sql).not.toContain('DROP COLUMN "certificate_code"');
    expect(sql).not.toContain('UPDATE "certificates" SET "certificate_code"');
  });

  it('removes the legacy unique index using its actual PostgreSQL object type', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260812090000_replace_certificate_unique_index/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('DROP INDEX IF EXISTS "certificates_user_id_course_id_key"');
    expect(sql).not.toContain('DROP CONSTRAINT');
  });
});
