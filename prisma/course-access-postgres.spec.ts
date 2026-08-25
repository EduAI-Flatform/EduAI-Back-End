import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { vector } = require('@electric-sql/pglite/vector');
const migrationsRoot = join(__dirname, 'migrations');
const accessMigration = '20260824180000_add_course_access_grants';

describe('Sprint 24 centralized course access on PostgreSQL', () => {
  let db: PGlite;

  const admin = '30000000-0000-4000-8000-000000000001';
  const learner = '30000000-0000-4000-8000-000000000002';
  const course = '30000000-0000-4000-8000-000000000003';
  const plan = '30000000-0000-4000-8000-000000000004';
  const version = '30000000-0000-4000-8000-000000000005';
  const activeEnrollment = '30000000-0000-4000-8000-000000000006';
  const pendingEnrollment = '30000000-0000-4000-8000-000000000007';
  const secondLearner = '30000000-0000-4000-8000-000000000008';

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto, vector } });
    for (const directory of readdirSync(migrationsRoot).sort()) {
      if (directory >= accessMigration) continue;
      const path = join(migrationsRoot, directory, 'migration.sql');
      if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    }
    await db.exec(`
      INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES
        ('${admin}', 'access-admin@example.test', 'hash', 'Admin', CURRENT_TIMESTAMP),
        ('${learner}', 'access-learner@example.test', 'hash', 'Learner', CURRENT_TIMESTAMP),
        ('${secondLearner}', 'access-second@example.test', 'hash', 'Second', CURRENT_TIMESTAMP);
      INSERT INTO courses (
        id, instructor_id, title, slug, level, status, visibility,
        moderation_status, updated_at
      ) VALUES (
        '${course}', '${admin}', 'Access Course', 'access-course', 'beginner',
        'published', 'public', 'clear', CURRENT_TIMESTAMP
      );
      INSERT INTO enrollments (id, user_id, course_id, status, updated_at) VALUES
        ('${activeEnrollment}', '${learner}', '${course}', 'active', CURRENT_TIMESTAMP),
        ('${pendingEnrollment}', '${secondLearner}', '${course}', 'pending', CURRENT_TIMESTAMP);
      INSERT INTO membership_plans (id, code, updated_at)
        VALUES ('${plan}', 'ACCESS_PLAN', CURRENT_TIMESTAMP);
      INSERT INTO membership_plan_versions (
        id, plan_id, version_number, display_name, base_monthly_price_amount_minor,
        currency, status, created_by_id, updated_at
      ) VALUES (
        '${version}', '${plan}', 1, 'Access Plan', 0, 'VND', 'draft', '${admin}', CURRENT_TIMESTAMP
      );
      INSERT INTO membership_duration_options (version_id, months, price_amount_minor, display_order)
        VALUES ('${version}', 1, 0, 0);
    `);
    await db.exec(readFileSync(join(migrationsRoot, accessMigration, 'migration.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => db.close());

  it('backfills only qualifying legacy access and records reconciliation issues', async () => {
    const grants = await db.query<{ source_id: string }>(`
      SELECT source_id FROM course_access_grants
      WHERE source_type = 'legacy_enrollment' ORDER BY source_id
    `);
    const issues = await db.query<{ enrollment_id: string; reason_code: string }>(`
      SELECT enrollment_id, reason_code FROM course_access_backfill_issues
    `);
    expect(grants.rows).toEqual([{ source_id: activeEnrollment }]);
    expect(issues.rows).toEqual([{
      enrollment_id: pendingEnrollment,
      reason_code: 'INELIGIBLE_ENROLLMENT_STATUS',
    }]);
  });

  it('freezes included-course mappings with the purchased plan version', async () => {
    await db.exec(`
      INSERT INTO membership_plan_included_courses (version_id, course_id, grace_days, created_by_id)
      VALUES ('${version}', '${course}', 7, '${admin}');
      UPDATE membership_plan_versions
        SET status = 'published', published_by_id = '${admin}',
            published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${version}';
    `);
    await expect(db.exec(`
      UPDATE membership_plan_included_courses SET grace_days = 3
      WHERE version_id = '${version}' AND course_id = '${course}'
    `)).rejects.toThrow(/published membership course inclusions are immutable/);
    await expect(db.exec(`
      DELETE FROM membership_plan_included_courses
      WHERE version_id = '${version}' AND course_id = '${course}'
    `)).rejects.toThrow(/published membership course inclusions are immutable/);
  });

  it('preserves concurrent independent grants and revokes only the selected source', async () => {
    await db.exec(`
      INSERT INTO course_access_grants (
        user_id, course_id, source_type, source_id, starts_at
      ) VALUES
        ('${learner}', '${course}', 'scholarship', 'award-1', CURRENT_TIMESTAMP),
        ('${learner}', '${course}', 'tmi_reward', 'redemption-1', CURRENT_TIMESTAMP);
      UPDATE course_access_grants
        SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
            revocation_reason = 'TMI_REWARD_REFUNDED'
        WHERE user_id = '${learner}' AND course_id = '${course}'
          AND source_type = 'tmi_reward' AND source_id = 'redemption-1';
    `);
    const rows = await db.query<{ source_type: string; status: string }>(`
      SELECT source_type, status FROM course_access_grants
      WHERE user_id = '${learner}' AND course_id = '${course}'
        AND source_type IN ('scholarship', 'tmi_reward')
      ORDER BY source_type
    `);
    expect(rows.rows).toEqual([
      { source_type: 'scholarship', status: 'active' },
      { source_type: 'tmi_reward', status: 'revoked' },
    ]);
    await expect(db.exec(`
      DELETE FROM course_access_grants
      WHERE user_id = '${learner}' AND source_type = 'scholarship'
    `)).rejects.toThrow(/course access grants are append-only/);
  });
});
