import type { PrismaClient } from '../generated/prisma/client';
import {
  DEMO_ACCOUNTS,
  DEMO_ASSETS,
  DEMO_EXPECTED_COUNTS,
  DEMO_IDS,
  demoClassroomSessions,
  demoCourses,
  demoEnrollments,
  demoFixtureIds,
  demoLessons,
  demoAssignments,
  demoLibraryResources,
  demoQuizAttempts,
} from './demo-fixtures';

const AI_COURSE_KEYWORDS =
  /ai|machine learning|deep learning|computer vision|natural language processing|openai|prompt|data science/i;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireDemoSeedPassword(
  environment: NodeJS.ProcessEnv,
): string {
  if (environment.NODE_ENV?.trim() === 'production') {
    throw new Error('Demo seed is disabled when NODE_ENV=production');
  }

  const password = environment.DEMO_ACCOUNT_PASSWORD;
  if (!password?.trim()) {
    throw new Error('DEMO_ACCOUNT_PASSWORD is required for demo seed');
  }

  return password;
}

export function assertDemoFixtureContract(): void {
  const expectedFixtureCounts = {
    users: DEMO_EXPECTED_COUNTS.users,
    profiles: DEMO_EXPECTED_COUNTS.profiles,
    userRoles: DEMO_EXPECTED_COUNTS.userRoles,
    skills: DEMO_EXPECTED_COUNTS.skills,
    portfolios: DEMO_EXPECTED_COUNTS.portfolios,
    courses: DEMO_EXPECTED_COUNTS.courses,
    lessons: DEMO_EXPECTED_COUNTS.lessons,
    enrollments: DEMO_EXPECTED_COUNTS.enrollments,
    progress: DEMO_EXPECTED_COUNTS.primaryStudentProgress,
    reviews: DEMO_EXPECTED_COUNTS.reviews,
    quizzes: DEMO_EXPECTED_COUNTS.quizzes,
    questions: DEMO_EXPECTED_COUNTS.questions,
    quizAttempts: DEMO_EXPECTED_COUNTS.quizAttempts,
    assignments: DEMO_EXPECTED_COUNTS.assignments,
    submissions: DEMO_EXPECTED_COUNTS.submissions,
    classroomSessions: DEMO_EXPECTED_COUNTS.classroomSessions,
    classroomAttendance: DEMO_EXPECTED_COUNTS.classroomAttendance,
    classroomRecordings: DEMO_EXPECTED_COUNTS.classroomRecordings,
    libraryCategories: DEMO_EXPECTED_COUNTS.libraryCategories,
    libraryTags: DEMO_EXPECTED_COUNTS.libraryTags,
    libraryResources: DEMO_EXPECTED_COUNTS.libraryResources,
    resourceTags: DEMO_EXPECTED_COUNTS.resourceTags,
    savedResources: DEMO_EXPECTED_COUNTS.savedResources,
    communityPosts: DEMO_EXPECTED_COUNTS.communityPosts,
    communityComments: DEMO_EXPECTED_COUNTS.communityComments,
    communityReactions: DEMO_EXPECTED_COUNTS.communityReactions,
    certificateTemplates: DEMO_EXPECTED_COUNTS.certificateTemplates,
    certificates: DEMO_EXPECTED_COUNTS.certificates,
  } as const;

  for (const [entity, expected] of Object.entries(expectedFixtureCounts)) {
    const actual =
      demoFixtureIds[entity as keyof typeof demoFixtureIds].length;
    if (actual !== expected) {
      throw new Error(
        `Demo fixture contract mismatch for ${entity}: expected ${expected}, received ${actual}`,
      );
    }
  }

  const allIds = Object.values(demoFixtureIds).flat();
  const invalidId = allIds.find((id) => !UUID_V4_PATTERN.test(id));
  if (invalidId) {
    throw new Error(`Demo fixture ID is not a UUID v4: ${invalidId}`);
  }

  if (new Set(allIds).size !== allIds.length) {
    throw new Error('Demo fixture IDs must be globally unique');
  }

  if (
    demoCourses.length !== 10 ||
    demoCourses.some(
      (course) =>
        course.status !== 'published' ||
        course.visibility !== 'public' ||
        !course.title.trim() ||
        !course.description.trim() ||
        !AI_COURSE_KEYWORDS.test(`${course.title} ${course.description}`),
    )
  ) {
    throw new Error('Demo courses must contain ten published public AI courses');
  }

  if (
    new Set(Object.values(DEMO_ACCOUNTS)).size !== 3 ||
    new Set(DEMO_ASSETS.courseThumbnails).size !== 10
  ) {
    throw new Error('Demo accounts and course thumbnails must be unique');
  }

  if (new Set(demoCourses.map((course) => course.slug)).size !== demoCourses.length) {
    throw new Error('Demo course slugs must be unique');
  }

  for (const course of demoCourses) {
    const lessons = demoLessons.filter((lesson) => lesson.courseId === course.id);
    const orderIndexes = lessons.map((lesson) => lesson.orderIndex);
    if (
      lessons.length < 4 ||
      lessons.length > 6 ||
      new Set(orderIndexes).size !== lessons.length ||
      !lessons.some((lesson) => lesson.type === 'video' && lesson.videoUrl) ||
      !lessons.some((lesson) => lesson.type === 'article' && lesson.content) ||
      !lessons.some((lesson) => lesson.type === 'pdf' && lesson.documentUrl) ||
      !lessons.some((lesson) => lesson.isPreview)
    ) {
      throw new Error(`Demo course lesson coverage is incomplete: ${course.id}`);
    }
  }

  const primaryStudentCourses = new Set(
    demoEnrollments
      .filter((enrollment) => enrollment.userId === DEMO_IDS.primaryStudent)
      .map((enrollment) => enrollment.courseId),
  );
  if (
    primaryStudentCourses.size === 0 ||
    !demoCourses.some((course) => !primaryStudentCourses.has(course.id))
  ) {
    throw new Error('Primary demo student must have both enrolled and unregistered courses');
  }

  if (
    !demoClassroomSessions.some((session) => session.status === 'live') ||
    !demoClassroomSessions.some((session) => !primaryStudentCourses.has(session.courseId))
  ) {
    throw new Error('Demo classrooms must cover live enrolled and restricted sessions');
  }

  if (
    !demoQuizAttempts.some((attempt) => !attempt.passed) ||
    !demoAssignments.some((assignment) => assignment.dueOffsetDays < 0) ||
    !demoLibraryResources.some((resource) => resource.externalUrl)
  ) {
    throw new Error('Demo assessments and library must cover required states');
  }
}

export interface DemoVerificationResult {
  counts: Record<string, number>;
  passwordHashRoundsValid: boolean;
}

export async function verifyDemoData(
  prisma: PrismaClient,
): Promise<DemoVerificationResult> {
  assertDemoFixtureContract();

  const countQueries = {
    roles: prisma.role.count({
      where: {
        name: { in: ['student', 'instructor', 'platform_admin'] },
      },
    }),
    users: prisma.user.count({
      where: { id: { in: [...demoFixtureIds.users] } },
    }),
    profiles: prisma.userProfile.count({
      where: { id: { in: [...demoFixtureIds.profiles] } },
    }),
    userRoles: prisma.userRole.count({
      where: { id: { in: [...demoFixtureIds.userRoles] } },
    }),
    skills: prisma.userSkill.count({
      where: { id: { in: [...demoFixtureIds.skills] } },
    }),
    portfolios: prisma.portfolio.count({
      where: { id: { in: [...demoFixtureIds.portfolios] } },
    }),
    courses: prisma.course.count({
      where: { id: { in: [...demoFixtureIds.courses] } },
    }),
    lessons: prisma.lesson.count({
      where: { id: { in: [...demoFixtureIds.lessons] } },
    }),
    enrollments: prisma.enrollment.count({
      where: { id: { in: [...demoFixtureIds.enrollments] } },
    }),
    primaryStudentProgress: prisma.learningProgress.count({
      where: { id: { in: [...demoFixtureIds.progress] } },
    }),
    reviews: prisma.courseReview.count({
      where: { id: { in: [...demoFixtureIds.reviews] } },
    }),
    quizzes: prisma.quiz.count({
      where: { id: { in: [...demoFixtureIds.quizzes] } },
    }),
    questions: prisma.question.count({
      where: { id: { in: [...demoFixtureIds.questions] } },
    }),
    quizAttempts: prisma.quizAttempt.count({
      where: { id: { in: [...demoFixtureIds.quizAttempts] } },
    }),
    assignments: prisma.assignment.count({
      where: { id: { in: [...demoFixtureIds.assignments] } },
    }),
    submissions: prisma.submission.count({
      where: { id: { in: [...demoFixtureIds.submissions] } },
    }),
    classroomSessions: prisma.classroomSession.count({
      where: { id: { in: [...demoFixtureIds.classroomSessions] } },
    }),
    classroomAttendance: prisma.classroomAttendance.count({
      where: { id: { in: [...demoFixtureIds.classroomAttendance] } },
    }),
    classroomRecordings: prisma.classroomRecording.count({
      where: { id: { in: [...demoFixtureIds.classroomRecordings] } },
    }),
    libraryCategories: prisma.libraryCategory.count({
      where: { id: { in: [...demoFixtureIds.libraryCategories] } },
    }),
    libraryTags: prisma.libraryTag.count({
      where: { id: { in: [...demoFixtureIds.libraryTags] } },
    }),
    libraryResources: prisma.libraryResource.count({
      where: { id: { in: [...demoFixtureIds.libraryResources] } },
    }),
    resourceTags: prisma.resourceTag.count({
      where: { id: { in: [...demoFixtureIds.resourceTags] } },
    }),
    savedResources: prisma.savedResource.count({
      where: { id: { in: [...demoFixtureIds.savedResources] } },
    }),
    communityPosts: prisma.communityPost.count({
      where: { id: { in: [...demoFixtureIds.communityPosts] } },
    }),
    communityComments: prisma.communityComment.count({
      where: { id: { in: [...demoFixtureIds.communityComments] } },
    }),
    communityReactions: prisma.communityReaction.count({
      where: { id: { in: [...demoFixtureIds.communityReactions] } },
    }),
    certificateTemplates: prisma.certificateTemplate.count({
      where: { id: { in: [...demoFixtureIds.certificateTemplates] } },
    }),
    certificates: prisma.certificate.count({
      where: { id: { in: [...demoFixtureIds.certificates] } },
    }),
  };

  const entries = await Promise.all(
    Object.entries(countQueries).map(async ([name, query]) => [
      name,
      await query,
    ] as const),
  );
  const counts = Object.fromEntries(entries);

  for (const [entity, expected] of Object.entries(DEMO_EXPECTED_COUNTS)) {
    const actual = counts[entity];
    if (actual !== expected) {
      throw new Error(
        `Demo verification failed for ${entity}: expected ${expected}, received ${String(actual)}`,
      );
    }
  }

  const [courseShape, demoAccounts, primaryStudentEnrollment, unregisteredCourse,
    liveEnrolledSession, restrictedSession, failedAttempt, overdueAssignment,
    externalLibraryResource] = await Promise.all([
    prisma.course.findMany({
      where: { id: { in: [...demoFixtureIds.courses] } },
      select: {
        id: true,
        title: true,
        description: true,
        slug: true,
        status: true,
        visibility: true,
        lessons: {
          where: { deletedAt: null },
          select: {
            type: true,
            content: true,
            videoUrl: true,
            documentUrl: true,
            isPreview: true,
            orderIndex: true,
          },
        },
      },
    }),
    prisma.user.count({
      where: {
        email: { in: Object.values(DEMO_ACCOUNTS) },
        id: { in: [...demoFixtureIds.users] },
      },
    }),
    prisma.enrollment.count({
      where: {
        userId: DEMO_IDS.primaryStudent,
        id: { in: [...demoFixtureIds.enrollments] },
      },
    }),
    prisma.course.count({
      where: {
        id: { in: [...demoFixtureIds.courses] },
        status: 'published',
        visibility: 'public',
        enrollments: { none: { userId: DEMO_IDS.primaryStudent } },
      },
    }),
    prisma.classroomSession.count({
      where: {
        id: { in: [...demoFixtureIds.classroomSessions] },
        status: 'live',
        course: { enrollments: { some: { userId: DEMO_IDS.primaryStudent } } },
      },
    }),
    prisma.classroomSession.count({
      where: {
        id: { in: [...demoFixtureIds.classroomSessions] },
        course: { enrollments: { none: { userId: DEMO_IDS.primaryStudent } } },
      },
    }),
    prisma.quizAttempt.count({
      where: {
        id: { in: [...demoFixtureIds.quizAttempts] },
        passed: false,
      },
    }),
    prisma.assignment.count({
      where: {
        id: { in: [...demoFixtureIds.assignments] },
        dueDate: { lt: new Date() },
      },
    }),
    prisma.libraryResource.count({
      where: {
        id: { in: [...demoFixtureIds.libraryResources] },
        externalUrl: { not: null },
      },
    }),
  ]);

  const catalogIsValid =
    courseShape.length === DEMO_EXPECTED_COUNTS.courses &&
    courseShape.every(
      (course) =>
        course.title.trim().length > 0 &&
        course.slug.trim().length > 0 &&
        course.status === 'published' &&
        course.visibility === 'public' &&
        AI_COURSE_KEYWORDS.test(`${course.title} ${course.description ?? ''}`) &&
        course.lessons.length >= 4 &&
        course.lessons.length <= 6 &&
        course.lessons.some((lesson) => lesson.type === 'video' && lesson.videoUrl) &&
        course.lessons.some((lesson) => lesson.type === 'article' && lesson.content) &&
        course.lessons.some((lesson) => lesson.type === 'pdf' && lesson.documentUrl) &&
        course.lessons.some((lesson) => lesson.isPreview),
    ) &&
    new Set(courseShape.map((course) => course.slug)).size === courseShape.length;

  if (
    !catalogIsValid ||
    demoAccounts !== Object.values(DEMO_ACCOUNTS).length ||
    primaryStudentEnrollment === 0 ||
    unregisteredCourse === 0 ||
    liveEnrolledSession === 0 ||
    restrictedSession === 0 ||
    failedAttempt === 0 ||
    overdueAssignment === 0 ||
    externalLibraryResource === 0
  ) {
    throw new Error('Demo relational integrity verification failed');
  }

  const demoPasswordHashes = await prisma.user.findMany({
    where: { id: { in: [...demoFixtureIds.users] } },
    select: { passwordHash: true },
  });
  const passwordHashRoundsValid =
    demoPasswordHashes.length === DEMO_EXPECTED_COUNTS.users &&
    demoPasswordHashes.every(
      ({ passwordHash }) =>
        typeof passwordHash === 'string' &&
        /^\$2[aby]\$12\$/.test(passwordHash),
    );

  if (!passwordHashRoundsValid) {
    throw new Error('Demo password hashes must use bcrypt with 12 rounds');
  }

  return { counts, passwordHashRoundsValid };
}
