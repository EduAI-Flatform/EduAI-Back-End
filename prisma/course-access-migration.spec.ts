import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20260824180000_add_course_access_grants', 'migration.sql'), 'utf8');

describe('Sprint 24 centralized course access migration', () => {
  it('adds immutable included-course snapshots and additive access grants', () => {
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).toContain('CREATE TABLE "membership_plan_included_courses"');
    expect(sql).toContain('CREATE TABLE "course_access_grants"');
    expect(sql).toContain('course_access_grants_source_key');
    expect(sql).toContain('published membership course inclusions are immutable');
  });

  it('backfills only qualifying legacy enrollments at the recorded cutover', () => {
    expect(sql).toContain("TIMESTAMP '2026-08-24 16:45:00'");
    expect(sql).toContain("WHERE e.\"status\" IN ('active', 'completed')");
    expect(sql).toContain("'legacy_enrollment'");
    expect(sql).toContain("sa.\"benefit_kind\" = 'course_access'");
    expect(sql).toContain("te.\"kind\" = 'course_access'");
    expect(sql).toContain('INSERT INTO "learning_progress"');
    expect(sql).toContain('CREATE TABLE "course_access_backfill_issues"');
    expect(sql).toContain("'INELIGIBLE_ENROLLMENT_STATUS'");
  });

  it('preserves grants and learning history through append-only transition guards', () => {
    expect(sql).toContain('course access grants are append-only');
    expect(sql).toContain('course access grant facts are immutable');
    expect(sql).not.toMatch(/DELETE FROM "(enrollments|learning_progress|certificates)"/);
  });
});
