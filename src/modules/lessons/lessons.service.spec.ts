import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  LessonType,
  ModerationStatus,
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
  moderationStatus: ModerationStatus;
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
  moderationStatus: ModerationStatus.clear,
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
  it('returns complete lesson content for an anonymous public preview', async () => {
    const { prisma, service } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      ...lesson,
      course: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        enrollments: [],
      },
    });

    await expect(service.getLesson(undefined, lesson.id)).resolves.toEqual(
      expect.objectContaining({
        id: lesson.id,
        content: lesson.content,
        videoUrl: lesson.videoUrl,
        documentUrl: lesson.documentUrl,
      }),
    );
    expect(prisma.lesson.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.lesson.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: lesson.id,
          deletedAt: null,
          course: { deletedAt: null },
        }),
        select: expect.objectContaining({
          content: true,
          videoUrl: true,
          documentUrl: true,
          course: expect.any(Object),
        }),
      }),
    );
  });

  it('does not expose a moderated course preview publicly', async () => {
    const { prisma, service } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      ...lesson,
      course: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        moderationStatus: ModerationStatus.hidden,
        enrollments: [],
      },
    });

    await expect(service.getLesson(undefined, lesson.id)).rejects.toEqual(
      new NotFoundException('Lesson not found'),
    );
  });

  it('returns a non-preview lesson to an enrolled student', async () => {
    const { prisma, service } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      ...lesson,
      isPreview: false,
      course: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.private,
        enrollments: [{ id: 'enrollment-id' }],
      },
    });

    await expect(service.getLesson(student, lesson.id)).resolves.toEqual(
      expect.objectContaining({ id: lesson.id, isPreview: false }),
    );
    expect(prisma.lesson.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          course: {
            select: expect.objectContaining({
              enrollments: {
                where: {
                  userId: student.id,
                  status: { in: ['active', 'completed'] },
                },
                select: { id: true },
                take: 1,
              },
            }),
          },
        }),
      }),
    );
  });

  it('returns draft lesson content to its instructor and platform admins', async () => {
    const { prisma, service } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      ...lesson,
      isPreview: false,
      course: {
        ...course,
        enrollments: [],
      },
    });

    await expect(service.getLesson(instructor, lesson.id)).resolves.toEqual(
      expect.objectContaining({ id: lesson.id }),
    );
    await expect(service.getLesson(admin, lesson.id)).resolves.toEqual(
      expect.objectContaining({ id: lesson.id }),
    );
  });

  it('does not expose a protected lesson to an anonymous or unenrolled viewer', async () => {
    const { prisma, service } = createService();
    prisma.lesson.findFirst.mockResolvedValue({
      ...lesson,
      isPreview: false,
      course: {
        ...course,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
        enrollments: [],
      },
    });

    await expect(service.getLesson(undefined, lesson.id)).rejects.toEqual(
      new NotFoundException('Lesson not found'),
    );
    await expect(service.getLesson(student, lesson.id)).rejects.toEqual(
      new NotFoundException('Lesson not found'),
    );
  });

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
        moderationStatus: ModerationStatus.clear,
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

  it('lists lessons for owned draft courses in instructor management', async () => {
    const { prisma, service } = createService();

    await service.listInstructorLessons(instructor, course.id);

    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: {
        id: course.id,
        deletedAt: null,
      },
      select: { instructorId: true },
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

  it('rejects instructor lesson lists for unowned courses', async () => {
    const { prisma, service } = createService();

    await expect(
      service.listInstructorLessons(otherInstructor, course.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
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
      select: { instructorId: true },
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
      select: {
        id: true,
        courseId: true,
        title: true,
        slug: true,
        type: true,
        content: true,
        videoUrl: true,
        documentUrl: true,
        orderIndex: true,
        durationMinutes: true,
        isPreview: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('rejects lesson creation by non-owners', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createLesson(otherInstructor, course.id, {
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
      select: {
        id: true,
        courseId: true,
        title: true,
        slug: true,
        type: true,
        content: true,
        videoUrl: true,
        documentUrl: true,
        orderIndex: true,
        durationMinutes: true,
        isPreview: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('rejects updates when the lesson is not in a manageable course', async () => {
    const { prisma, service } = createService();

    await expect(
      service.updateLesson(otherInstructor, lesson.id, {
        title: 'Updated introduction',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lesson.update).not.toHaveBeenCalled();
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
