import type { PrismaClient } from '../generated/prisma/client';
import { DEMO_IDS, fixtureUuid } from './demo-fixtures';

export const MINIMAL_FIXTURE_IDS = {
  category: fixtureUuid(0xa0, 1),
  resource: fixtureUuid(0xa1, 1),
  courses: [
    fixtureUuid(0xa2, 1),
    fixtureUuid(0xa2, 2),
    fixtureUuid(0xa2, 3),
    fixtureUuid(0xa2, 4),
  ],
  lessons: [
    fixtureUuid(0xa3, 1),
    fixtureUuid(0xa3, 2),
    fixtureUuid(0xa3, 3),
    fixtureUuid(0xa3, 4),
    fixtureUuid(0xa3, 5),
    fixtureUuid(0xa3, 6),
  ],
  enrollments: [fixtureUuid(0xa4, 1)],
  progress: [fixtureUuid(0xa5, 1)],
  reviews: [fixtureUuid(0xa6, 1)],
} as const;

export const minimalCourseFixtures = [
  {
    id: MINIMAL_FIXTURE_IDS.courses[0],
    slug: 'sprint21-test-paid-course',
    title: 'Sprint 21 Test — Paid Course',
    description: 'Synthetic paid course fixture for contract tests.',
    status: 'published' as const,
    visibility: 'public' as const,
    level: 'beginner' as const,
    badge: 'TEST_SUPPORT_PAID',
    priceAmountMinor: 1499000,
    priceCurrency: 'VND',
    category: 'test-ai-foundations',
    promotion: null,
  },
  {
    id: MINIMAL_FIXTURE_IDS.courses[1],
    slug: 'sprint21-test-free-course',
    title: 'Sprint 21 Test — Free Course',
    description: 'Synthetic free course fixture for contract tests.',
    status: 'published' as const,
    visibility: 'public' as const,
    level: 'beginner' as const,
    badge: 'TEST_SUPPORT_FREE',
    priceAmountMinor: 0,
    priceCurrency: 'VND',
    category: 'test-ai-foundations',
    promotion: null,
  },
  {
    id: MINIMAL_FIXTURE_IDS.courses[2],
    slug: 'sprint21-test-promotion-ready-course',
    title: 'Sprint 21 Test — Promotion Ready Course',
    description: 'Synthetic promotion-ready course fixture for contract tests.',
    status: 'published' as const,
    visibility: 'public' as const,
    level: 'intermediate' as const,
    badge: 'TEST_SUPPORT_PROMOTION_READY',
    priceAmountMinor: 999000,
    priceCurrency: 'VND',
    category: 'test-ai-foundations',
    promotion: {
      originalAmountMinor: 1499000,
      currency: 'VND',
      label: 'TEST_SUPPORT_PROMOTION',
    },
  },
  {
    id: MINIMAL_FIXTURE_IDS.courses[3],
    slug: 'sprint21-test-unpublished-course',
    title: 'Sprint 21 Test — Unpublished Course',
    description: 'Synthetic unpublished course fixture for display tests.',
    status: 'draft' as const,
    visibility: 'private' as const,
    level: 'advanced' as const,
    badge: 'TEST_SUPPORT_UNPUBLISHED',
    priceAmountMinor: 1999000,
    priceCurrency: 'VND',
    category: 'test-ai-foundations',
    promotion: null,
  },
] as const;

export const minimalUnpublishedFixture = {
  status: 'draft' as const,
  visibility: 'private' as const,
  priceAmountMinor: 1999000,
  priceCurrency: 'VND',
  presentationState: 'unpublished' as const,
};

export function assertMinimalFixtureEnvironment(
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.NODE_ENV?.trim() === 'production') {
    throw new Error('Minimal course fixtures are disabled when NODE_ENV=production');
  }

  if (environment.MINIMAL_FIXTURES_ENABLED !== 'true') {
    throw new Error('MINIMAL_FIXTURES_ENABLED=true is required for minimal fixtures');
  }
}

export async function seedMinimalCourseFixtures(
  prisma: PrismaClient,
): Promise<{ courses: number; lessons: number; resource: number }> {
  await prisma.$transaction(async (tx) => {
    await tx.libraryCategory.upsert({
      where: { id: MINIMAL_FIXTURE_IDS.category },
      create: {
        id: MINIMAL_FIXTURE_IDS.category,
        name: 'Sprint 21 Test Category',
        slug: 'sprint21-test-category',
        description: 'Synthetic TEST_SUPPORT category; not final demo content.',
      },
      update: {
        name: 'Sprint 21 Test Category',
        slug: 'sprint21-test-category',
        description: 'Synthetic TEST_SUPPORT category; not final demo content.',
      },
    });

    await tx.libraryResource.upsert({
      where: { id: MINIMAL_FIXTURE_IDS.resource },
      create: {
        id: MINIMAL_FIXTURE_IDS.resource,
        ownerId: DEMO_IDS.primaryInstructor,
        categoryId: MINIMAL_FIXTURE_IDS.category,
        title: 'Sprint 21 Test Resource',
        description: 'Synthetic resource fixture for course contract tests.',
        type: 'article',
        fileUrl: '/test-fixtures/sprint21-resource.md',
        visibility: 'public',
      },
      update: {
        ownerId: DEMO_IDS.primaryInstructor,
        categoryId: MINIMAL_FIXTURE_IDS.category,
        title: 'Sprint 21 Test Resource',
        description: 'Synthetic resource fixture for course contract tests.',
        type: 'article',
        fileUrl: '/test-fixtures/sprint21-resource.md',
        visibility: 'public',
        deletedAt: null,
      },
    });

    for (const course of minimalCourseFixtures) {
      await tx.course.upsert({
        where: { id: course.id },
        create: {
          id: course.id,
          instructorId: DEMO_IDS.primaryInstructor,
          title: course.title,
          slug: course.slug,
          description: course.description,
          thumbnailUrl: '/demo-assets/course-placeholder.svg',
          badge: course.badge,
          priceAmountMinor: course.priceAmountMinor,
          priceCurrency: course.priceCurrency,
          level: course.level,
          status: course.status,
          visibility: course.visibility,
        },
        update: {
          instructorId: DEMO_IDS.primaryInstructor,
          title: course.title,
          description: course.description,
          thumbnailUrl: '/demo-assets/course-placeholder.svg',
          badge: course.badge,
          priceAmountMinor: course.priceAmountMinor,
          priceCurrency: course.priceCurrency,
          level: course.level,
          status: course.status,
          visibility: course.visibility,
          deletedAt: null,
        },
      });
    }

    const lessons = [
      { id: MINIMAL_FIXTURE_IDS.lessons[0], courseId: MINIMAL_FIXTURE_IDS.courses[0], type: 'video' as const, title: 'Paid preview', videoUrl: '/test-fixtures/sprint21-paid.mp4', content: null, documentUrl: null, orderIndex: 1 },
      { id: MINIMAL_FIXTURE_IDS.lessons[1], courseId: MINIMAL_FIXTURE_IDS.courses[0], type: 'article' as const, title: 'Paid article', videoUrl: null, content: 'Synthetic paid lesson content.', documentUrl: null, orderIndex: 2 },
      { id: MINIMAL_FIXTURE_IDS.lessons[2], courseId: MINIMAL_FIXTURE_IDS.courses[1], type: 'video' as const, title: 'Free preview', videoUrl: '/test-fixtures/sprint21-free.mp4', content: null, documentUrl: null, orderIndex: 1 },
      { id: MINIMAL_FIXTURE_IDS.lessons[3], courseId: MINIMAL_FIXTURE_IDS.courses[1], type: 'pdf' as const, title: 'Free worksheet', videoUrl: null, content: null, documentUrl: '/test-fixtures/sprint21-free.pdf', orderIndex: 2 },
      { id: MINIMAL_FIXTURE_IDS.lessons[4], courseId: MINIMAL_FIXTURE_IDS.courses[2], type: 'video' as const, title: 'Promotion preview', videoUrl: '/test-fixtures/sprint21-promotion.mp4', content: null, documentUrl: null, orderIndex: 1 },
      { id: MINIMAL_FIXTURE_IDS.lessons[5], courseId: MINIMAL_FIXTURE_IDS.courses[2], type: 'article' as const, title: 'Promotion article', videoUrl: null, content: 'Synthetic promotion lesson content.', documentUrl: null, orderIndex: 2 },
    ];

    for (const lesson of lessons) {
      await tx.lesson.upsert({
        where: { id: lesson.id },
        create: {
          ...lesson,
          slug: lesson.title.toLowerCase().replaceAll(' ', '-'),
          durationMinutes: 15,
          isPreview: lesson.orderIndex === 1,
          isRequired: true,
        },
        update: {
          courseId: lesson.courseId,
          title: lesson.title,
          slug: lesson.title.toLowerCase().replaceAll(' ', '-'),
          type: lesson.type,
          content: lesson.content,
          videoUrl: lesson.videoUrl,
          documentUrl: lesson.documentUrl,
          orderIndex: lesson.orderIndex,
          durationMinutes: 15,
          isPreview: lesson.orderIndex === 1,
          isRequired: true,
          deletedAt: null,
        },
      });
    }

    await tx.enrollment.upsert({
      where: { id: MINIMAL_FIXTURE_IDS.enrollments[0] },
      create: {
        id: MINIMAL_FIXTURE_IDS.enrollments[0],
        userId: DEMO_IDS.primaryStudent,
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        status: 'active',
      },
      update: {
        userId: DEMO_IDS.primaryStudent,
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        status: 'active',
        completedAt: null,
      },
    });

    await tx.learningProgress.upsert({
      where: { id: MINIMAL_FIXTURE_IDS.progress[0] },
      create: {
        id: MINIMAL_FIXTURE_IDS.progress[0],
        userId: DEMO_IDS.primaryStudent,
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        lessonId: MINIMAL_FIXTURE_IDS.lessons[0],
        status: 'in_progress',
        progressPercent: 50,
        watchedSeconds: 450,
        durationSeconds: 900,
        lastPositionSeconds: 450,
        maxWatchedSeconds: 450,
        lastAccessedAt: new Date(),
      },
      update: {
        userId: DEMO_IDS.primaryStudent,
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        lessonId: MINIMAL_FIXTURE_IDS.lessons[0],
        status: 'in_progress',
        progressPercent: 50,
        watchedSeconds: 450,
        durationSeconds: 900,
        lastPositionSeconds: 450,
        maxWatchedSeconds: 450,
        lastAccessedAt: new Date(),
      },
    });

    await tx.courseReview.upsert({
      where: { id: MINIMAL_FIXTURE_IDS.reviews[0] },
      create: {
        id: MINIMAL_FIXTURE_IDS.reviews[0],
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        userId: DEMO_IDS.primaryStudent,
        rating: 5,
        comment: 'Synthetic TEST_SUPPORT review.',
      },
      update: {
        courseId: MINIMAL_FIXTURE_IDS.courses[0],
        userId: DEMO_IDS.primaryStudent,
        rating: 5,
        comment: 'Synthetic TEST_SUPPORT review.',
      },
    });
  });

  return { courses: minimalCourseFixtures.length, lessons: MINIMAL_FIXTURE_IDS.lessons.length, resource: 1 };
}

export async function verifyMinimalCourseFixtures(
  prisma: PrismaClient,
): Promise<{ courses: number; lessons: number; resource: number; enrolled: number; progress: number; reviews: number }> {
  const [courses, lessons, resource, enrolled, progress, reviews] = await Promise.all([
    prisma.course.count({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.courses] } } }),
    prisma.lesson.count({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.lessons] } } }),
    prisma.libraryResource.count({ where: { id: MINIMAL_FIXTURE_IDS.resource } }),
    prisma.enrollment.count({ where: { id: MINIMAL_FIXTURE_IDS.enrollments[0] } }),
    prisma.learningProgress.count({ where: { id: MINIMAL_FIXTURE_IDS.progress[0] } }),
    prisma.courseReview.count({ where: { id: MINIMAL_FIXTURE_IDS.reviews[0] } }),
  ]);
  const result = { courses, lessons, resource, enrolled, progress, reviews };
  if (courses !== 4 || lessons !== 6 || resource !== 1 || enrolled !== 1 || progress !== 1 || reviews !== 1) {
    throw new Error(`Minimal fixture verification failed: ${JSON.stringify(result)}`);
  }

  const [courseRows, lessonRows, category] = await Promise.all([
    prisma.course.findMany({
      where: { id: { in: [...MINIMAL_FIXTURE_IDS.courses] } },
      select: {
        id: true,
        status: true,
        visibility: true,
        priceAmountMinor: true,
        priceCurrency: true,
      },
    }),
    prisma.lesson.findMany({
      where: { id: { in: [...MINIMAL_FIXTURE_IDS.lessons] } },
      select: { type: true, isPreview: true },
    }),
    prisma.libraryCategory.findUnique({
      where: { id: MINIMAL_FIXTURE_IDS.category },
      select: { slug: true },
    }),
  ]);
  const courseById = new Map(courseRows.map((course) => [course.id, course]));
  const unpublished = courseById.get(MINIMAL_FIXTURE_IDS.courses[3]);
  const published = MINIMAL_FIXTURE_IDS.courses.slice(0, 3).map((id) => courseById.get(id));
  if (
    !unpublished ||
    unpublished.status !== 'draft' ||
    unpublished.visibility !== 'private' ||
    published.some(
      (course) =>
        !course ||
        course.status !== 'published' ||
        course.visibility !== 'public' ||
        course.priceAmountMinor === null ||
        course.priceCurrency !== 'VND',
    ) ||
    courseById.get(MINIMAL_FIXTURE_IDS.courses[1])?.priceAmountMinor !== 0 ||
    !lessonRows.some((lesson) => lesson.type === 'video') ||
    !lessonRows.some((lesson) => lesson.type === 'article') ||
    !lessonRows.some((lesson) => lesson.type === 'pdf') ||
    !lessonRows.some((lesson) => lesson.isPreview) ||
    category?.slug !== 'sprint21-test-category'
  ) {
    throw new Error('Minimal fixture state matrix is incomplete');
  }
  return result;
}

export async function resetMinimalCourseFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.courseReview.deleteMany({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.reviews] } } });
    await tx.learningProgress.deleteMany({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.progress] } } });
    await tx.enrollment.deleteMany({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.enrollments] } } });
    await tx.lesson.deleteMany({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.lessons] } } });
    await tx.course.deleteMany({ where: { id: { in: [...MINIMAL_FIXTURE_IDS.courses] } } });
    await tx.libraryResource.deleteMany({ where: { id: MINIMAL_FIXTURE_IDS.resource } });
    await tx.libraryCategory.deleteMany({ where: { id: MINIMAL_FIXTURE_IDS.category } });
  });
}
