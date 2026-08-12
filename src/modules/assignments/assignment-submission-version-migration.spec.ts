import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('assignment submission version migrations', () => {
  it('removes only the standalone two-column legacy unique index', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260812070000_drop_legacy_submission_unique_index/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain("index_metadata.indrelid = 'submissions'::REGCLASS");
    expect(sql).toContain('index_metadata.indisunique');
    expect(sql).toContain('NOT index_metadata.indisprimary');
    expect(sql).toContain('constraint_metadata.conindid = index_metadata.indexrelid');
    expect(sql).toContain("ARRAY['assignment_id', 'user_id']::NAME[]");
    expect(sql).not.toContain("ARRAY['assignment_id', 'user_id', 'version']::NAME[]");
  });
});
