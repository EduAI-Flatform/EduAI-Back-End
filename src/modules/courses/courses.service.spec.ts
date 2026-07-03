import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  LessonType,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
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
  level: CourseLevel;
  status: CourseStatus;
  visibility: CourseVisibility;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  _count: {
    lessons: number;
  };
}

const course: TestCourse = {
  id: 'course-id',
  instructorId: instructor.id,
  title: 'AI Foundations',
  slug: 'ai-foundations',
  description: null,
  thumbnailUrl: null,
  level: CourseLevel.beginner,
  status: CourseStatus.draft,
  visibility: CourseVisibility.public,
  createdAt: new Date('2026-06-18T00:00:00.000Z'),
  updatedAt: new Date('2026-06-18T00:00:00.000Z'),
  deletedAt: null,
  _count: {
    lessons: 1,
  },
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
  storedEnrollment?: typeof progressEnrollment | null;
  progress?: typeof progressRows;
}) {
  const storedCourse = options?.storedCourse ?? course;
  let prisma: {
    $transaction: jest.Mock;
    course: {
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
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
        if (args?.select?.lessons) {
          return Promise.resolve(
            options && 'storedPublishedCourse' in options
              ? options.storedPublishedCourse
              : publishedCourseWithLessons,
          );
        }

        return Promise.resolve(storedCourse);
      }),
      findMany: jest.fn().mockResolvedValue([course]),
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
  };

  return {
    prisma,
    service: new CoursesService(prisma as never),
  };
}

describe('CoursesService', () => {
  it('lists only published public courses for public browsing', async () => {
    const { prisma, service } = createService();

    await service.listCourses();

    expect(prisma.course.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        thumbnailUrl: true,
        level: true,
        status: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
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
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        thumbnailUrl: true,
        level: true,
        status: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
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

  it('rejects updates by non-owners', async () => {
    const { prisma, service } = createService();

    await expect(
      service.updateCourse(otherInstructor, course.id, {
        title: 'Updated title',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
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
  });

  it('rejects publishing courses without lessons', async () => {
    const { prisma, service } = createService({
      storedCourse: {
        ...course,
        _count: {
          lessons: 0,
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
    const { prisma, service } = createService();

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
      },
    });

    await expect(service.getCourse(course.id)).resolves.toEqual({
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      level: course.level,
      status: CourseStatus.published,
      visibility: CourseVisibility.public,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      lessonCount: 1,
    });
  });

  it('enrolls users in published courses and initializes lesson progress', async () => {
    const { prisma, service } = createService();

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
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        thumbnailUrl: true,
        level: true,
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
    expect(prisma.learningProgress.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: student.id,
          courseId: course.id,
          lessonId: lesson.id,
          status: 'not_started',
          progressPercent: 0,
        },
      ],
      skipDuplicates: true,
    });
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
      select: expect.any(Object),
    });
  });

  it('completes a lesson for an enrolled student and returns course progress', async () => {
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
    expect(prisma.learningProgress.upsert).toHaveBeenCalledWith({
      where: {
        userId_lessonId: {
          userId: student.id,
          lessonId: 'lesson-1',
        },
      },
      create: {
        userId: student.id,
        courseId: course.id,
        lessonId: 'lesson-1',
        status: 'completed',
        progressPercent: 100,
        completedAt: expect.any(Date),
        lastAccessedAt: expect.any(Date),
      },
      update: {
        status: 'completed',
        progressPercent: 100,
        completedAt: expect.any(Date),
        lastAccessedAt: expect.any(Date),
      },
    });
  });

  it('rejects lesson completion when the student is not enrolled', async () => {
    const { prisma, service } = createService({ storedEnrollment: null });

    await expect(service.completeLesson(student.id, 'lesson-1')).rejects.toEqual(
      new NotFoundException('Enrollment not found'),
    );
    expect(prisma.learningProgress.upsert).not.toHaveBeenCalled();
  });

  it('marks the enrollment completed when all lessons are complete', async () => {
    const { prisma, service } = createService({
      progress: [
        { ...progressRows[0], lessonId: 'lesson-1' },
        { ...progressRows[0], lessonId: 'lesson-2' },
      ],
    });

    await expect(service.completeLesson(student.id, 'lesson-1')).resolves.toMatchObject({
      completedLessons: 2,
      totalLessons: 2,
      progressPercent: 100,
      completed: true,
    });
    expect(prisma.enrollment.update).toHaveBeenCalledWith({
      where: { id: progressEnrollment.id },
      data: {
        status: 'completed',
        completedAt: expect.any(Date),
      },
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
});
