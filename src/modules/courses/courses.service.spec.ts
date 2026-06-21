import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
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

function createService(options?: { storedCourse?: typeof course | null }) {
  const storedCourse = options?.storedCourse ?? course;
  const prisma = {
    course: {
      create: jest.fn().mockResolvedValue(course),
      findFirst: jest.fn().mockResolvedValue(storedCourse),
      findMany: jest.fn().mockResolvedValue([course]),
      update: jest.fn().mockResolvedValue({
        ...course,
        status: CourseStatus.published,
      }),
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

  it('rejects updates by non-owners', async () => {
    const { service } = createService();

    await expect(
      service.updateCourse(student, course.id, { title: 'Updated title' }),
    ).rejects.toBeInstanceOf(NotFoundException);
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

  it('rejects publishing courses without lessons', async () => {
    const { service } = createService({
      storedCourse: {
        ...course,
        _count: {
          lessons: 0,
        },
      },
    });

    await expect(service.publishCourse(instructor, course.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
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
});
