import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertDemoFixtureContract,
  requireDemoSeedPassword,
} from './demo-contract';
import {
  DEMO_ASSETS,
  DEMO_EXPECTED_COUNTS,
  DEMO_IDS,
  demoClassroomSessions,
  demoCourses,
  demoFixtureIds,
  demoLessons,
  demoEnrollments,
} from './demo-fixtures';
import { PASSWORD_HASH_ROUNDS } from '../src/modules/auth/password.service';
import {
  assertMinimalFixtureEnvironment,
  MINIMAL_FIXTURE_IDS,
  minimalCourseFixtures,
} from './minimal-course-fixtures';

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
      courses: 10,
      lessons: 40,
      enrollments: 53,
      primaryStudentProgress: 16,
      reviews: 51,
      quizzes: 3,
      questions: 12,
      quizAttempts: 2,
      assignments: 3,
      submissions: 2,
      classroomSessions: 4,
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

  it('defines ten public published AI courses with deep lesson coverage', () => {
    expect(demoCourses).toHaveLength(10);
    expect(new Set(DEMO_ASSETS.courseThumbnails).size).toBe(10);
    expect(new Set(demoCourses.map((course) => course.slug)).size).toBe(10);
    expect(demoCourses).toEqual(
      expect.arrayContaining(
        demoCourses.map((course) =>
          expect.objectContaining({
            status: 'published',
            visibility: 'public',
          }),
        ),
      ),
    );

    for (const course of demoCourses) {
      const lessons = demoLessons.filter((lesson) => lesson.courseId === course.id);
      expect(lessons.length).toBeGreaterThanOrEqual(4);
      expect(lessons.length).toBeLessThanOrEqual(6);
      expect(new Set(lessons.map((lesson) => lesson.orderIndex)).size).toBe(lessons.length);
      expect(lessons.map((lesson) => lesson.orderIndex)).toEqual(
        [...lessons].sort((left, right) => left.orderIndex - right.orderIndex).map((lesson) => lesson.orderIndex),
      );
      expect(lessons.some((lesson) => lesson.type === 'video' && lesson.videoUrl)).toBe(true);
      expect(lessons.some((lesson) => lesson.type === 'article' && lesson.content)).toBe(true);
      expect(lessons.some((lesson) => lesson.type === 'pdf' && lesson.documentUrl)).toBe(true);
      expect(lessons.some((lesson) => lesson.isPreview)).toBe(true);
    }
  });

  it('keeps student demo states and classroom authorization fixtures distinct', () => {
    const primaryStudentCourses = new Set(
      demoEnrollments
        .filter((enrollment) => enrollment.userId === DEMO_IDS.primaryStudent)
        .map((enrollment) => enrollment.courseId),
    );

    expect(primaryStudentCourses.size).toBeGreaterThan(0);
    expect(demoCourses.some((course) => !primaryStudentCourses.has(course.id))).toBe(true);
    expect(demoClassroomSessions.some((session) => String(session.status) === 'live')).toBe(true);
    expect(
      demoClassroomSessions.some((session) => !primaryStudentCourses.has(session.courseId)),
    ).toBe(true);
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

  it('uses the application password service for demo account hashes', () => {
    const source = readFileSync(resolve(__dirname, 'demo-seed.ts'), 'utf8');

    expect(PASSWORD_HASH_ROUNDS).toBe(12);
    expect(source).toContain('new PasswordService().hashPassword(password)');
    expect(source).not.toContain('bcrypt.hash');
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

describe('Sprint 21 minimal fixture design contract', () => {
  it('keeps test-support fixtures separate from the final demo dataset', () => {
    const contract = readFileSync(
      resolve(
        __dirname,
        '..',
        '..',
        'EduAI_Docs',
        'docs',
        'tasks_2.0',
        'sprint-21',
        'SPR21-006-minimal-fixture-contract.md',
      ),
      'utf8',
    );

    expect(contract).toContain('A_MINIMAL_TEST_FIXTURE');
    expect(contract).toContain('TEST_SUPPORT');
    const normalizedContract = contract.toLowerCase();
    expect(normalizedContract).toContain('free');
    expect(normalizedContract).toContain('paid');
    expect(normalizedContract).toContain('promotion-ready');
    expect(normalizedContract).toContain('unpublished');
    expect(contract).toContain('Final Demo Course Dataset');
    expect(normalizedContract).toContain('must not');
    expect(normalizedContract).toContain('no migration');
  });

  it('defines deterministic free, paid, and promotion-ready fixture projections', () => {
    expect(minimalCourseFixtures).toHaveLength(4);
    expect(new Set(MINIMAL_FIXTURE_IDS.courses).size).toBe(4);
    expect(minimalCourseFixtures.map(({ priceAmountMinor }) => priceAmountMinor)).toEqual([
      1499000,
      0,
      999000,
      1999000,
    ]);
    expect(minimalCourseFixtures[2].promotion).toEqual(
      expect.objectContaining({ originalAmountMinor: 1499000 }),
    );
    expect(minimalCourseFixtures[3]).toMatchObject({
      status: 'draft',
      visibility: 'private',
    });
  });

  it('requires an explicit non-production guard for fixture writes', () => {
    expect(() =>
      assertMinimalFixtureEnvironment({ NODE_ENV: 'production', MINIMAL_FIXTURES_ENABLED: 'true' }),
    ).toThrow('disabled when NODE_ENV=production');
    expect(() =>
      assertMinimalFixtureEnvironment({ NODE_ENV: 'development' }),
    ).toThrow('MINIMAL_FIXTURES_ENABLED=true');
    expect(() =>
      assertMinimalFixtureEnvironment({ NODE_ENV: 'development', MINIMAL_FIXTURES_ENABLED: 'true' }),
    ).not.toThrow();
  });
});
