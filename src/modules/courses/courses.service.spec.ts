import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  LessonType,
  ModerationStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CoursesService } from './courses.service';

const instructor: AuthenticatedUser = {
  id: 'instructor-id',
  roles: [RoleName.instructor],
};

const admin: AuthenticatedUser = {
  id: 'admin-id',
  roles: [RoleName.platform_admin],
};

const otherInstructor: AuthenticatedUser = {
  id: 'other-instructor-id',
  roles: [RoleName.instructor],
};

const student: AuthenticatedUser = {
  id: 'student-id',
  roles: [RoleName.student],
};

interface TestCourse {
  id: string;
  instructorId: string;
  title: string;
  slug: string;
  description: string | null;
  thumbnailUrl: string | null;
  badge: string | null;
  featuredRank: number | null;
  priceAmountMinor: number | null;
  priceCurrency: string | null;
  level: CourseLevel;
  status: CourseStatus;
  visibility: CourseVisibility;
  moderationStatus: ModerationStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  _count: {
    lessons: number;
    enrollments: number;
    reviews: number;
  };
  instructor: {
    id: string;
    fullName: string;
    avatarUrl: string | null;
    profile: {
      headline: string | null;
      bio: string | null;
    } | null;
  };
  lessons: Array<{ durationMinutes: number | null }>;
  enrollments: Array<{ id: string }>;
  reviews: Array<{ rating: number }>;
}

const course: TestCourse = {
  id: 'course-id',
  instructorId: instructor.id,
  title: 'AI Foundations',
  slug: 'ai-foundations',
  description: null,
  thumbnailUrl: null,
  badge: 'Phổ biến',
  featuredRank: 1,
  priceAmountMinor: 1499000,
  priceCurrency: 'VND',
  level: CourseLevel.beginner,
  status: CourseStatus.draft,
  visibility: CourseVisibility.public,
  moderationStatus: ModerationStatus.clear,
  createdAt: new Date('2026-06-18T00:00:00.000Z'),
  updatedAt: new Date('2026-06-18T00:00:00.000Z'),
  deletedAt: null,
  _count: {
    lessons: 1,
    enrollments: 2,
    reviews: 2,
  },
  instructor: {
    id: instructor.id,
    fullName: 'Sarah Nguyen',
    avatarUrl: '/demo/avatars/sarah-nguyen.svg',
    profile: {
      headline: 'AI Instructor',
      bio: 'Giảng viên AI ứng dụng.',
    },
  },
  lessons: [{ durationMinutes: 42 }],
  enrollments: [{ id: 'enrollment-1' }, { id: 'enrollment-2' }],
  reviews: [{ rating: 5 }, { rating: 4 }],
};

const lesson = {
  id: 'lesson-id',
  orderIndex: 1,
};

const publishedCourseWithLessons = {
  id: course.id,
  title: course.title,
  slug: course.slug,
  description: course.description,
  thumbnailUrl: course.thumbnailUrl,
  level: course.level,
  status: CourseStatus.published,
  visibility: course.visibility,
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
  lessons: [lesson],
};

const enrollment = {
  id: 'enrollment-id',
  userId: student.id,
  courseId: course.id,
  status: 'active',
  enrolledAt: new Date('2026-07-01T00:00:00.000Z'),
  completedAt: null,
  course: {
    id: course.id,
    title: course.title,
    slug: course.slug,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl,
    level: course.level,
    status: CourseStatus.published,
    visibility: course.visibility,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
    lessons: [
      {
        id: 'lesson-id',
        title: 'Introduction',
        slug: 'introduction',
        type: LessonType.video,
        orderIndex: 1,
        durationMinutes: 10,
        isPreview: false,
        progress: [{ status: 'not_started', progressPercent: 0 }],
      },
    ],
  },
};

const progressLesson = {
  id: 'lesson-1',
  courseId: course.id,
  course: {
    id: course.id,
    lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
  },
};

const progressEnrollment = {
  id: 'progress-enrollment-id',
  userId: student.id,
  courseId: course.id,
  status: 'active',
  completedAt: null,
  course: {
    lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
  },
};

const progressRows = [
  {
    lessonId: 'lesson-1',
    status: 'completed',
    progressPercent: 100,
    completedAt: new Date('2026-07-01T00:00:00.000Z'),
    lastAccessedAt: new Date('2026-07-01T00:00:00.000Z'),
  },
  {
    lessonId: 'lesson-2',
    status: 'not_started',
    progressPercent: 0,
    completedAt: null,
    lastAccessedAt: null,
  },
];

function createService(options?: {
  storedCourse?: typeof course | null;
  storedPublishedCourse?: typeof publishedCourseWithLessons | null;
  existingEnrollment?: { id: string } | null;
  storedLesson?: typeof progressLesson | null;
  storedEnrollment?:
    | (Omit<typeof progressEnrollment, 'completedAt'> & {
        completedAt: Date | null;
      })
    | null;
  progress?: typeof progressRows;
  completionResult?: {
    completed: boolean;
    completedRequiredItems: number;
    totalRequiredItems: number;
    enrollmentUpdated: boolean;
  };
}) {
  const storedCourse = options?.storedCourse ?? course;
  let prisma: {
    $transaction: jest.Mock;
    course: {
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    enrollment: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    learningProgress: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
    lesson: { findFirst: jest.Mock };
    courseReview: {
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  prisma = {
    $transaction: jest.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return input(prisma);
      }

      return Promise.all(input as Promise<unknown>[]);
    }),
    course: {
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue(course),
      findFirst: jest.fn().mockImplementation((args) => {
        if (args?.select?.lessons && !args?.select?.instructorId) {
          return Promise.resolve(
            options && 'storedPublishedCourse' in options
              ? options.storedPublishedCourse
              : publishedCourseWithLessons,
          );
        }

        return Promise.resolve(storedCourse);
      }),
      findMany: jest.fn().mockResolvedValue([course]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({
        ...course,
        status: CourseStatus.published,
      }),
    },
    enrollment: {
      create: jest.fn().mockResolvedValue(enrollment),
      findFirst: jest.fn().mockImplementation((args) => {
        if (args?.select?.course) {
          return Promise.resolve(
            options && 'storedEnrollment' in options
              ? options.storedEnrollment
              : progressEnrollment,
          );
        }

        if (args?.select?.completedAt) {
          return Promise.resolve(
            options && 'storedEnrollment' in options
              ? options.storedEnrollment
              : progressEnrollment,
          );
        }

        return Promise.resolve(options?.existingEnrollment ?? null);
      }),
      findMany: jest.fn().mockResolvedValue([enrollment]),
      update: jest.fn().mockResolvedValue(progressEnrollment),
    },
    learningProgress: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(options?.progress ?? progressRows),
      upsert: jest.fn().mockResolvedValue(progressRows[0]),
    },
    lesson: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options && 'storedLesson' in options ? options.storedLesson : progressLesson,
        ),
    },
    courseReview: {
      aggregate: jest.fn().mockResolvedValue({
        _avg: { rating: 4.5 },
        _count: { rating: 2 },
      }),
      groupBy: jest.fn().mockResolvedValue([
        {
          courseId: course.id,
          _avg: { rating: 4.5 },
          _count: { rating: 2 },
        },
      ]),
    },
  };

  const storage = {
    deleteThumbnail: jest.fn().mockResolvedValue(undefined),
    uploadThumbnail: jest.fn().mockResolvedValue({
      key: 'course-thumbnails/generated.png',
      url: 'https://cdn.example.com/course-thumbnails/generated.png',
    }),
  };
  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };
  const completionService = {
    evaluateAndSync: jest.fn().mockResolvedValue(
      options?.completionResult ?? {
        completed: false,
        completedRequiredItems: 1,
        totalRequiredItems: 2,
        enrollmentUpdated: false,
      },
    ),
  };
  const courseAccess = {
    decide: jest.fn().mockResolvedValue({ allowed: true, mode: 'LEARNER' }),
    require: jest.fn().mockResolvedValue({ allowed: true, mode: 'LEARNER' }),
    ensureGrant: jest.fn().mockResolvedValue({ id: 'grant-id' }),
  };

  return {
    auditService,
    completionService,
    courseAccess,
    prisma,
    storage,
    service: new CoursesService(
      prisma as never,
      storage as never,
      auditService as never,
      completionService as never,
      courseAccess as never,
    ),
  };
}

describe('CoursesService', () => {
  it('lists published public courses with real catalog aggregates', async () => {
    const { prisma, service } = createService();

    const result = await service.listCourses();

    expect(result).toEqual([
      expect.objectContaining({
        id: course.id,
        badge: 'Phổ biến',
        featuredRank: 1,
        price: { amountMinor: 1499000, currency: 'VND' },
        instructor: {
          id: instructor.id,
          fullName: 'Sarah Nguyen',
          avatarUrl: '/demo/avatars/sarah-nguyen.svg',
          headline: 'AI Instructor',
        },
        metrics: {
          lessonCount: 1,
          durationMinutes: 42,
          enrollmentCount: 2,
          ratingAverage: 4.5,
          ratingCount: 2,
        },
      }),
    ]);

    expect(prisma.course.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.clear,
      },
      orderBy: [{ featuredRank: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: expect.objectContaining({
        badge: true,
        featuredRank: true,
        priceAmountMinor: true,
        priceCurrency: true,
        instructor: expect.any(Object),
        lessons: expect.any(Object),
        _count: expect.any(Object),
      }),
    });
    const catalogSelect = prisma.course.findMany.mock.calls[0][0].select;
    expect(catalogSelect).not.toHaveProperty('enrollments');
    expect(catalogSelect).not.toHaveProperty('reviews');
    expect(prisma.courseReview.groupBy).toHaveBeenCalledWith({
      by: ['courseId'],
      where: { courseId: { in: [course.id] } },
      _avg: { rating: true },
      _count: { rating: true },
    });
  });

  it('lists only authenticated instructor-owned courses with pagination and filters', async () => {
    const { prisma, service } = createService();

    await service.listInstructorCourses(instructor, {
      page: 2,
      pageSize: 10,
      status: CourseStatus.published,
      search: 'React',
    });

    const where = {
      instructorId: instructor.id,
      status: CourseStatus.published,
      OR: [
        { title: { contains: 'React', mode: 'insensitive' } },
        { slug: { contains: 'React', mode: 'insensitive' } },
        { description: { contains: 'React', mode: 'insensitive' } },
      ],
    };

    expect(prisma.course.count).toHaveBeenCalledWith({ where });
    expect(prisma.course.findMany).toHaveBeenCalledWith({
      where,
      orderBy: {
        updatedAt: 'desc',
      },
      skip: 10,
      take: 10,
      select: expect.objectContaining({
        badge: true,
        featuredRank: true,
        priceAmountMinor: true,
        priceCurrency: true,
        instructor: expect.any(Object),
        lessons: expect.any(Object),
        _count: expect.any(Object),
      }),
    });
  });

  it('rejects instructor course listing by non-instructors', async () => {
    const { prisma, service } = createService();

    await expect(
      service.listInstructorCourses(student, {
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toEqual(new ForbiddenException('Instructor role required'));
    expect(prisma.course.findMany).not.toHaveBeenCalled();
  });

  it('rejects course creation by students', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createCourse(student, {
        title: 'AI Foundations',
        slug: 'ai-foundations',
        level: CourseLevel.beginner,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('creates draft courses for instructors', async () => {
    const { prisma, service } = createService();

    await service.createCourse(instructor, {
      title: 'AI Foundations',
      slug: 'ai-foundations',
      badge: 'Mới',
      priceAmountMinor: 1499000,
      priceCurrency: 'VND',
      level: CourseLevel.beginner,
      visibility: CourseVisibility.private,
    });

    expect(prisma.course.create).toHaveBeenCalledWith({
      data: {
        instructorId: instructor.id,
        title: 'AI Foundations',
        slug: 'ai-foundations',
        description: undefined,
        thumbnailUrl: undefined,
        badge: 'Mới',
        priceAmountMinor: 1499000,
        priceCurrency: 'VND',
        level: CourseLevel.beginner,
        status: CourseStatus.draft,
        visibility: CourseVisibility.private,
      },
      select: {
        id: true,
        status: true,
      },
    });
  });

  it('rejects a course price without its currency pair', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createCourse(instructor, {
        title: 'AI Foundations',
        level: CourseLevel.beginner,
        priceAmountMinor: 1499000,
      }),
    ).rejects.toEqual(
      new BadRequestException(
        'priceAmountMinor and priceCurrency must be provided together',
      ),
    );
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('rejects negative prices before reaching Prisma', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createCourse(instructor, {
        title: 'AI Foundations',
        level: CourseLevel.beginner,
        priceAmountMinor: -1,
        priceCurrency: 'VND',
      }),
    ).rejects.toEqual(
      new BadRequestException('priceAmountMinor must be a non-negative integer'),
    );
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('rejects malformed currency codes before reaching Prisma', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createCourse(instructor, {
        title: 'AI Foundations',
        level: CourseLevel.beginner,
        priceAmountMinor: 1499000,
        priceCurrency: 'dong',
      }),
    ).rejects.toEqual(
      new BadRequestException('priceCurrency must be a three-letter ISO 4217 code'),
    );
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('generates a unique Vietnamese slug when the client omits it', async () => {
    const { prisma, service } = createService();
    prisma.course.findUnique
      .mockResolvedValueOnce({ id: 'existing-course' })
      .mockResolvedValueOnce(null);

    await service.createCourse(instructor, {
      title: 'Nền tảng Trí tuệ Nhân tạo',
      level: CourseLevel.beginner,
    });

    expect(prisma.course.findUnique).toHaveBeenNthCalledWith(1, {
      where: { slug: 'nen-tang-tri-tue-nhan-tao' },
      select: { id: true },
    });
    expect(prisma.course.findUnique).toHaveBeenNthCalledWith(2, {
      where: { slug: 'nen-tang-tri-tue-nhan-tao-2' },
      select: { id: true },
    });
    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'nen-tang-tri-tue-nhan-tao-2',
        }),
      }),
    );
  });

  it('retries with the next generated slug after a concurrent slug conflict', async () => {
    const { prisma, service } = createService();
    const slugConflict = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: '7.8.0',
        meta: { target: ['slug'] },
      },
    );
    prisma.course.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'concurrent-course' })
      .mockResolvedValueOnce(null);
    prisma.course.create
      .mockRejectedValueOnce(slugConflict)
      .mockResolvedValueOnce(course);

    await service.createCourse(instructor, {
      title: 'AI Foundations',
      level: CourseLevel.beginner,
    });

    expect(prisma.course.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'ai-foundations-2',
        }),
      }),
    );
  });

  it('uploads a selected thumbnail and stores the generated R2 URL and key', async () => {
    const { prisma, service, storage } = createService();
    const thumbnail = {
      buffer: Buffer.from('thumbnail'),
      mimetype: 'image/png',
      originalname: 'client-controlled-name.png',
      size: 9,
    };

    await service.createCourse(
      instructor,
      {
        title: 'AI Foundations',
        level: CourseLevel.beginner,
      },
      thumbnail,
    );

    expect(storage.uploadThumbnail).toHaveBeenCalledWith(thumbnail);
    expect(prisma.course.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          thumbnailUrl:
            'https://cdn.example.com/course-thumbnails/generated.png',
          thumbnailStorageKey: 'course-thumbnails/generated.png',
        }),
      }),
    );
  });

  it('does not create a course when thumbnail upload fails', async () => {
    const { prisma, service, storage } = createService();
    storage.uploadThumbnail.mockRejectedValue(
      new InternalServerErrorException('R2 upload failed'),
    );

    await expect(
      service.createCourse(
        instructor,
        {
          title: 'AI Foundations',
          level: CourseLevel.beginner,
        },
        {
          buffer: Buffer.from('thumbnail'),
          mimetype: 'image/png',
          originalname: 'thumbnail.png',
          size: 9,
        },
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('rejects updates by non-owners', async () => {
    const { prisma, service, storage } = createService();

    await expect(
      service.updateCourse(
        otherInstructor,
        course.id,
        {
          title: 'Updated title',
        },
        {
          buffer: Buffer.from('thumbnail'),
          mimetype: 'image/png',
          originalname: 'thumbnail.png',
          size: 9,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.uploadThumbnail).not.toHaveBeenCalled();
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('maps duplicate course slugs to conflict', async () => {
    const { prisma, service } = createService();
    prisma.course.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
        meta: { target: ['slug'] },
      }),
    );

    await expect(
      service.createCourse(instructor, {
        title: 'Duplicate course',
        slug: course.slug,
        level: CourseLevel.beginner,
      }),
    ).rejects.toEqual(new ConflictException('Course slug is already in use'));
  });

  it('lets owners update editable course fields', async () => {
    const { prisma, service } = createService();

    await service.updateCourse(instructor, course.id, {
      title: 'Updated title',
      description: null,
    });

    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: course.id },
      data: {
        title: 'Updated title',
        description: null,
      },
      select: {
        id: true,
        status: true,
      },
    });
    const managementLookup = prisma.course.findFirst.mock.calls[0][0];
    expect(managementLookup.select).not.toHaveProperty('enrollments');
    expect(managementLookup.select).not.toHaveProperty('reviews');
    expect(managementLookup.select).not.toHaveProperty('instructor');
    expect(managementLookup.select).not.toHaveProperty('lessons');
  });

  it('replaces a thumbnail only after the course update and cleans up the old key', async () => {
    const { prisma, service, storage } = createService({
      storedCourse: {
        ...course,
        thumbnailUrl: 'https://cdn.example.com/course-thumbnails/old.png',
        thumbnailStorageKey: 'course-thumbnails/old.png',
      } as never,
    });
    const thumbnail = {
      buffer: Buffer.from('thumbnail'),
      mimetype: 'image/png',
      originalname: 'new.png',
      size: 9,
    };

    await service.updateCourse(instructor, course.id, { title: 'Updated' }, thumbnail);

    expect(prisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          thumbnailStorageKey: 'course-thumbnails/generated.png',
        }),
      }),
    );
    expect(storage.deleteThumbnail).toHaveBeenCalledWith('course-thumbnails/old.png');
  });

  it('keeps the existing slug when only the course title changes', async () => {
    const { prisma, service } = createService();

    await service.updateCourse(instructor, course.id, {
      title: 'A completely new title',
    });

    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: course.id },
      data: {
        title: 'A completely new title',
      },
      select: {
        id: true,
        status: true,
      },
    });
    expect(prisma.course.findUnique).not.toHaveBeenCalled();
  });

  it('rejects publishing courses without lessons', async () => {
    const { prisma, service } = createService({
      storedCourse: {
        ...course,
        _count: {
          lessons: 0,
          enrollments: 2,
          reviews: 2,
        },
      },
    });

    await expect(service.publishCourse(instructor, course.id)).rejects.toEqual(
      new BadRequestException(
        'Course must have at least one lesson before publication',
      ),
    );
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('publishes owned courses with at least one lesson', async () => {
    const { auditService, prisma, service } = createService();

    await service.publishCourse(instructor, course.id);

    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: course.id },
      data: {
        status: CourseStatus.published,
      },
      select: {
        id: true,
        status: true,
      },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: instructor.id,
        action: AuditAction.CoursePublished,
        target: { type: 'course', id: course.id },
        metadata: { status: CourseStatus.published },
      },
      prisma,
    );
  });

  it('lets admins archive any course', async () => {
    const { prisma, service } = createService();

    await service.archiveCourse(admin, course.id);

    expect(prisma.course.update).toHaveBeenCalledWith({
      where: { id: course.id },
      data: {
        status: CourseStatus.archived,
      },
      select: {
        id: true,
        status: true,
      },
    });
  });

  it('returns published public courses without authentication', async () => {
    const { service } = createService({
      storedCourse: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.clear,
      },
    });

    await expect(service.getCourse(course.id)).resolves.toEqual({
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      badge: course.badge,
      featuredRank: course.featuredRank,
      price: {
        amountMinor: course.priceAmountMinor,
        currency: course.priceCurrency,
      },
      level: course.level,
      status: CourseStatus.published,
      visibility: CourseVisibility.public,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      lessonCount: 1,
      instructor: {
        id: instructor.id,
        fullName: 'Sarah Nguyen',
        avatarUrl: '/demo/avatars/sarah-nguyen.svg',
        headline: 'AI Instructor',
        bio: 'Giảng viên AI ứng dụng.',
      },
      metrics: {
        lessonCount: 1,
        durationMinutes: 42,
        enrollmentCount: 2,
        ratingAverage: 4.5,
        ratingCount: 2,
      },
    });
  });

  it('hides a moderated public course from public detail while preserving owner access', async () => {
    const { service } = createService({
      storedCourse: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.hidden,
      },
    });

    await expect(service.getCourse(course.id)).rejects.toEqual(
      new NotFoundException('Course not found'),
    );
    await expect(service.getCourse(course.id, instructor)).resolves.toEqual(
      expect.objectContaining({ id: course.id }),
    );
  });

  it('enrolls users in published courses and initializes lesson progress', async () => {
    const { prisma, service, courseAccess } = createService();

    await expect(service.enrollCourse(student.id, course.id)).resolves.toEqual({
      success: true,
      message: 'Course enrolled successfully.',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: {
        id: course.id,
        deletedAt: null,
        status: CourseStatus.published,
        moderationStatus: ModerationStatus.clear,
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        thumbnailUrl: true,
          level: true,
          priceAmountMinor: true,
        status: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
        lessons: {
          where: { deletedAt: null },
          orderBy: { orderIndex: 'asc' },
          select: { id: true, orderIndex: true },
        },
      },
    });
    expect(prisma.enrollment.create).toHaveBeenCalledWith({
      data: {
        userId: student.id,
        courseId: course.id,
        status: 'active',
      },
      select: {
        id: true,
      },
    });
    expect(courseAccess.ensureGrant).toHaveBeenCalledWith({
      userId: student.id,
      courseId: course.id,
      sourceType: 'free_enrollment',
      sourceId: 'enrollment-id',
      startsAt: expect.any(Date),
    }, prisma);
  });

  it('rejects enrollment for missing or unpublished courses', async () => {
    const { prisma, service } = createService({ storedPublishedCourse: null });

    await expect(service.enrollCourse(student.id, course.id)).rejects.toEqual(
      new NotFoundException('Published course not found'),
    );
    expect(prisma.enrollment.create).not.toHaveBeenCalled();
    expect(prisma.learningProgress.createMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate enrollment', async () => {
    const { prisma, service } = createService({
      existingEnrollment: { id: enrollment.id },
    });

    await expect(service.enrollCourse(student.id, course.id)).rejects.toEqual(
      new ConflictException('Course already enrolled'),
    );
    expect(prisma.enrollment.create).not.toHaveBeenCalled();
    expect(prisma.learningProgress.createMany).not.toHaveBeenCalled();
  });

  it('lists authenticated user enrollments with lean course and progress data', async () => {
    const { prisma, service } = createService();

    await expect(service.getMyEnrollments(student.id)).resolves.toEqual([
      {
        id: enrollment.id,
        courseId: course.id,
        status: 'active',
        enrolledAt: enrollment.enrolledAt,
        completedAt: null,
        course: {
          id: course.id,
          title: 'AI Foundations',
          slug: 'ai-foundations',
          description: null,
          thumbnailUrl: null,
          level: CourseLevel.beginner,
          status: CourseStatus.published,
          visibility: CourseVisibility.public,
          createdAt: enrollment.course.createdAt,
          updatedAt: enrollment.course.updatedAt,
        },
        progress: {
          completedLessons: 0,
          totalLessons: 1,
          progressPercent: 0,
        },
      },
    ]);
    expect(prisma.enrollment.findMany).toHaveBeenCalledWith({
      where: { userId: student.id },
      orderBy: { enrolledAt: 'desc' },
      take: 100,
      select: expect.any(Object),
    });
  });

  it('returns earned lesson progress without allowing manual completion', async () => {
    const { prisma, service } = createService();

    await expect(service.completeLesson(student.id, 'lesson-1')).resolves.toEqual({
      courseId: course.id,
      completedLessonIds: ['lesson-1'],
      completedLessons: 1,
      totalLessons: 2,
      progressPercent: 50,
      completed: false,
    });

    expect(prisma.lesson.findFirst).toHaveBeenCalledWith({
      where: { id: 'lesson-1', deletedAt: null },
      select: {
        id: true,
        courseId: true,
        course: {
          select: {
            id: true,
            lessons: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        },
      },
    });
    expect(prisma.enrollment.findFirst).toHaveBeenCalledWith({
      where: {
        userId: student.id,
        courseId: course.id,
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
      },
    });
    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
  });

  it('rejects lesson completion when the student is not enrolled', async () => {
    const { prisma, service } = createService({ storedEnrollment: null });

    await expect(service.completeLesson(student.id, 'lesson-1')).rejects.toEqual(
      new NotFoundException('Enrollment not found'),
    );
    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
  });

  it('rejects the legacy completion route when progress was not earned', async () => {
    const { service } = createService({
      progress: [{ ...progressRows[0], lessonId: 'lesson-2' }],
    });

    await expect(service.completeLesson(student.id, 'lesson-1')).rejects.toEqual(
      new BadRequestException('Lesson completion must be earned through lesson progress'),
    );
  });

  it('delegates authoritative completion after earned lesson progress', async () => {
    const { completionService, prisma, service } = createService({
      progress: [
        { ...progressRows[0], lessonId: 'lesson-1' },
        { ...progressRows[0], lessonId: 'lesson-2' },
      ],
      completionResult: {
        completed: true,
        completedRequiredItems: 3,
        totalRequiredItems: 3,
        enrollmentUpdated: true,
      },
    });

    await expect(service.completeLesson(student.id, 'lesson-1')).resolves.toMatchObject({
      completedLessons: 2,
      totalLessons: 2,
      progressPercent: 100,
      completed: true,
    });
    expect(completionService.evaluateAndSync).toHaveBeenCalledWith(
      prisma,
      student.id,
      course.id,
    );
    expect(prisma.enrollment.update).not.toHaveBeenCalled();
  });

  it('does not report course completion from lesson-only progress', async () => {
    const { service } = createService({
      progress: [
        { ...progressRows[0], lessonId: 'lesson-1' },
        { ...progressRows[0], lessonId: 'lesson-2' },
      ],
    });

    await expect(service.completeLesson(student.id, 'lesson-1')).resolves.toMatchObject({
      completedLessons: 2,
      progressPercent: 100,
      completed: false,
    });
  });

  it('returns progress for an enrolled student without mutating lesson progress', async () => {
    const { prisma, service } = createService({
      progress: [{ ...progressRows[0], lessonId: 'lesson-2' }],
    });

    await expect(service.getCourseProgress(student.id, course.id)).resolves.toEqual({
      courseId: course.id,
      completedLessonIds: ['lesson-2'],
      completedLessons: 1,
      totalLessons: 2,
      progressPercent: 50,
      completed: false,
    });

    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
    expect(prisma.lesson.findFirst).not.toHaveBeenCalled();
    expect(prisma.enrollment.findFirst).toHaveBeenCalledWith({
      where: {
        userId: student.id,
        courseId: course.id,
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        course: {
          select: {
            lessons: {
              where: { deletedAt: null },
              select: { id: true },
            },
          },
        },
      },
    });
  });

  it('reports authoritative completion from enrollment state', async () => {
    const { service } = createService({
      storedEnrollment: {
        ...progressEnrollment,
        status: 'completed',
        completedAt: new Date('2026-07-02T00:00:00.000Z'),
      },
      progress: [{ ...progressRows[0], lessonId: 'lesson-1' }],
    });

    await expect(service.getCourseProgress(student.id, course.id)).resolves.toMatchObject({
      completedLessons: 1,
      totalLessons: 2,
      completed: true,
    });
  });
});
