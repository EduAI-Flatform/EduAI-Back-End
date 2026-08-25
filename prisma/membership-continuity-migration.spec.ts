import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260825160000_add_membership_removed_course_continuity', 'migration.sql'),
  'utf8',
);

describe('Sprint 24 removed-course continuity migration', () => {
  it('is additive, bounded, immutable, and keeps grace as an explicit access source', () => {
    expect(sql).toContain(`ALTER TYPE "course_access_source_type" ADD VALUE IF NOT EXISTS 'membership_grace'`);
    expect(sql).toContain('CREATE TABLE "membership_removed_course_snapshots"');
    expect(sql).toContain('membership_removed_course_snapshots_grace_days_check');
    expect(sql).toContain('membership_removed_course_snapshots_grace_window_check');
    expect(sql).toContain('membership_removed_course_snapshots_immutable');
    expect(sql).toContain('commerce_reject_immutable_change');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
  });
});
