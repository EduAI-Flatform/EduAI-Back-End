import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertDemoFixtureContract,
  requireDemoSeedPassword,
} from './demo-contract';
import {
  DEMO_EXPECTED_COUNTS,
  demoFixtureIds,
} from './demo-fixtures';
import { DEMO_BCRYPT_ROUNDS } from './demo-seed';

describe('demo data contract', () => {
  it('contains the exact fixture counts and globally unique UUID v4 IDs', () => {
    expect(() => assertDemoFixtureContract()).not.toThrow();

    expect(DEMO_EXPECTED_COUNTS).toEqual({
      roles: 3,
      users: 13,
      profiles: 13,
      userRoles: 13,
      skills: 8,
      portfolios: 2,
      courses: 9,
      lessons: 31,
      enrollments: 53,
      primaryStudentProgress: 16,
      reviews: 51,
      quizzes: 3,
      questions: 12,
      quizAttempts: 2,
      assignments: 3,
      submissions: 2,
      classroomSessions: 3,
      classroomAttendance: 2,
      classroomRecordings: 1,
      libraryCategories: 3,
      libraryTags: 5,
      libraryResources: 6,
      resourceTags: 10,
      savedResources: 2,
      communityPosts: 4,
      communityComments: 6,
      communityReactions: 7,
      certificateTemplates: 1,
      certificates: 2,
    });
    expect(demoFixtureIds.users).toHaveLength(DEMO_EXPECTED_COUNTS.users);
    expect(demoFixtureIds.courses).toHaveLength(DEMO_EXPECTED_COUNTS.courses);
    expect(demoFixtureIds.lessons).toHaveLength(DEMO_EXPECTED_COUNTS.lessons);
    expect(demoFixtureIds.enrollments).toHaveLength(
      DEMO_EXPECTED_COUNTS.enrollments,
    );
    expect(demoFixtureIds.reviews).toHaveLength(DEMO_EXPECTED_COUNTS.reviews);
  });

  it('rejects demo seed in production before accepting a password', () => {
    expect(() =>
      requireDemoSeedPassword({
        NODE_ENV: 'production',
        DEMO_ACCOUNT_PASSWORD: 'not-used',
      }),
    ).toThrow('Demo seed is disabled when NODE_ENV=production');
    expect(() =>
      requireDemoSeedPassword({
        NODE_ENV: ' production ',
        DEMO_ACCOUNT_PASSWORD: 'not-used',
      }),
    ).toThrow('Demo seed is disabled when NODE_ENV=production');
  });

  it('requires the demo password from the environment', () => {
    expect(() =>
      requireDemoSeedPassword({ NODE_ENV: 'development' }),
    ).toThrow('DEMO_ACCOUNT_PASSWORD is required for demo seed');
    expect(
      requireDemoSeedPassword({
        NODE_ENV: 'development',
        DEMO_ACCOUNT_PASSWORD: 'local-secret',
      }),
    ).toBe('local-secret');
  });

  it('hashes demo account passwords with twelve bcrypt rounds', () => {
    expect(DEMO_BCRYPT_ROUNDS).toBe(12);
  });

  it('uses upsert-only writes for every demo entity group', () => {
    const source = readFileSync(
      resolve(__dirname, 'demo-seed.ts'),
      'utf8',
    );

    expect(source.match(/\.upsert\(\{/g)).toHaveLength(28);
    expect(source).not.toMatch(
      /\.(?:create|createMany|delete|deleteMany)\s*\(/,
    );
    expect(source).not.toMatch(
      /refreshToken|aiConversation|aiGeneratedQuiz|aiFlashcard|embedding/i,
    );
  });
});

describe('course catalog migration contract', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      'migrations',
      '20260728000000_add_course_catalog_and_reviews',
      'migration.sql',
    ),
    'utf8',
  );

  it.each([
    '"badge" TEXT',
    '"featured_rank" INTEGER',
    '"price_amount_minor" INTEGER',
    '"price_currency" VARCHAR(3)',
  ])('adds the course catalog column %s', (column) => {
    expect(migration).toContain(column);
  });

  it('enforces safe course price and featured rank values', () => {
    expect(migration).toContain('"featured_rank" > 0');
    expect(migration).toContain('"price_amount_minor" >= 0');
    expect(migration).toContain('"courses_price_pair_check"');
  });

  it('creates constrained one-review-per-user course reviews', () => {
    expect(migration).toContain('CREATE TABLE "course_reviews"');
    expect(migration).toContain('"rating" BETWEEN 1 AND 5');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "course_reviews_course_id_user_id_key"',
    );
    expect(migration).toContain('ON "course_reviews"("course_id", "user_id")');
  });
});
