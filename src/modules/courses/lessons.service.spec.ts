import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  LessonType,
  RoleName,
} from '../../../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { LessonsService } from './lessons.service';

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
};

const lesson = {
  id: 'lesson-id',
  courseId: course.id,
  title: 'Introduction',
  slug: 'introduction',
  type: LessonType.video,
  content: null,
  videoUrl: 'https://example.com/video.mp4',
  documentUrl: null,
  orderIndex: 0,
  durationMinutes: 12,
  isPreview: true,
  createdAt: new Date('2026-06-18T00:00:00.000Z'),
  updatedAt: new Date('2026-06-18T00:00:00.000Z'),
  deletedAt: null,
  course,
};

function createService(options?: { storedCourse?: typeof course | null; storedLesson?: typeof lesson | null }) {
  const prisma = {
    course: {
      findFirst: jest.fn().mockResolvedValue(options?.storedCourse ?? course),
    },
    lesson: {
      create: jest.fn().mockResolvedValue(lesson),
      findFirst: jest.fn().mockResolvedValue(options?.storedLesson ?? lesson),
      findMany: jest.fn().mockResolvedValue([lesson]),
      update: jest.fn().mockResolvedValue(lesson),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return {
    prisma,
    service: new LessonsService(prisma as never),
  };
}

describe('LessonsService', () => {
  it('lists ordered non-deleted lesson metadata for published public courses', async () => {
    const { prisma, service } = createService({
      storedCourse: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
    });

    await service.listLessons(course.id);

    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: {
        id: course.id,
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
      select: { id: true },
    });
    expect(prisma.lesson.findMany).toHaveBeenCalledWith({
      where: { courseId: course.id, deletedAt: null },
      orderBy: { orderIndex: 'asc' },
      select: {
        id: true,
        courseId: true,
        title: true,
        slug: true,
        type: true,
        orderIndex: true,
        durationMinutes: true,
        isPreview: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('creates lessons inside an owned course', async () => {
    const { prisma, service } = createService();

    await service.createLesson(instructor, course.id, {
      title: 'Introduction',
      slug: 'introduction',
      type: LessonType.video,
      videoUrl: 'https://example.com/video.mp4',
      orderIndex: 0,
      durationMinutes: 12,
      isPreview: true,
    });

    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: {
        id: course.id,
        deletedAt: null,
      },
    });
    expect(prisma.lesson.create).toHaveBeenCalledWith({
      data: {
        courseId: course.id,
        title: 'Introduction',
        slug: 'introduction',
        type: LessonType.video,
        content: undefined,
        videoUrl: 'https://example.com/video.mp4',
        documentUrl: undefined,
        orderIndex: 0,
        durationMinutes: 12,
        isPreview: true,
      },
    });
  });

  it('rejects lesson creation by non-owners', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createLesson(student, course.id, {
        title: 'Introduction',
        slug: 'introduction',
        type: LessonType.article,
        orderIndex: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it('lets admins update any lesson', async () => {
    const { prisma, service } = createService();

    await service.updateLesson(admin, lesson.id, {
      title: 'Updated introduction',
      orderIndex: 1,
    });

    expect(prisma.lesson.update).toHaveBeenCalledWith({
      where: { id: lesson.id },
      data: {
        title: 'Updated introduction',
        orderIndex: 1,
      },
    });
  });

  it('rejects updates when the lesson is not in a manageable course', async () => {
    const { service } = createService();

    await expect(
      service.updateLesson(student, lesson.id, { title: 'Updated introduction' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('soft deletes lessons in owned courses', async () => {
    const { prisma, service } = createService();

    await expect(service.deleteLesson(instructor, lesson.id)).resolves.toEqual({
      deleted: true,
    });
    expect(prisma.lesson.updateMany).toHaveBeenCalledWith({
      where: {
        id: lesson.id,
        deletedAt: null,
      },
      data: {
        deletedAt: expect.any(Date),
      },
    });
  });

  it('maps duplicate lesson slug or order index to conflict', async () => {
    const { prisma, service } = createService();
    prisma.lesson.create.mockRejectedValue({
      code: 'P2002',
      meta: {
        target: ['course_id', 'order_index'],
      },
    });

    await expect(
      service.createLesson(instructor, course.id, {
        title: 'Introduction',
        slug: 'introduction',
        type: LessonType.article,
        orderIndex: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
