import {
  ClassroomSessionStatus,
  CourseStatus,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  it('returns explicit platform metrics from bounded aggregate queries', async () => {
    const prisma = {
      user: {
        groupBy: jest.fn().mockResolvedValue([
          { status: UserStatus.active, _count: { _all: 10 } },
          { status: UserStatus.inactive, _count: { _all: 3 } },
          { status: UserStatus.suspended, _count: { _all: 1 } },
        ]),
        count: jest
          .fn()
          .mockResolvedValueOnce(9)
          .mockResolvedValueOnce(4)
          .mockResolvedValueOnce(1),
      },
      course: {
        groupBy: jest.fn().mockResolvedValue([
          { status: CourseStatus.draft, _count: { _all: 2 } },
          { status: CourseStatus.published, _count: { _all: 5 } },
          { status: CourseStatus.archived, _count: { _all: 1 } },
        ]),
      },
      enrollment: {
        count: jest
          .fn()
          .mockResolvedValueOnce(12)
          .mockResolvedValueOnce(6)
          .mockResolvedValueOnce(2),
      },
      certificate: { count: jest.fn().mockResolvedValue(5) },
      aiConversation: { count: jest.fn().mockResolvedValue(7) },
      aiMessage: { count: jest.fn().mockResolvedValue(42) },
      aiGeneratedQuiz: { count: jest.fn().mockResolvedValue(6) },
      aiFlashcard: { count: jest.fn().mockResolvedValue(18) },
      aiEmbedding: { count: jest.fn().mockResolvedValue(30) },
      classroomSession: {
        groupBy: jest.fn().mockResolvedValue([
          { status: ClassroomSessionStatus.scheduled, _count: { _all: 3 } },
          { status: ClassroomSessionStatus.live, _count: { _all: 1 } },
          { status: ClassroomSessionStatus.ended, _count: { _all: 8 } },
        ]),
      },
      communityPost: { count: jest.fn().mockResolvedValue(15) },
      communityComment: { count: jest.fn().mockResolvedValue(28) },
      communityReaction: { count: jest.fn().mockResolvedValue(34) },
      libraryResource: { count: jest.fn().mockResolvedValue(11) },
      libraryCategory: { count: jest.fn().mockResolvedValue(4) },
      libraryTag: { count: jest.fn().mockResolvedValue(9) },
      savedResource: { count: jest.fn().mockResolvedValue(17) },
    };
    const service = new AdminService(prisma as never);

    await expect(service.getOverview()).resolves.toEqual({
      users: {
        total: 14,
        active: 10,
        inactive: 3,
        suspended: 1,
      },
      roles: {
        student: 9,
        instructor: 4,
        platformAdmin: 1,
      },
      courses: {
        total: 8,
        draft: 2,
        published: 5,
        archived: 1,
      },
      enrollments: {
        total: 20,
        active: 12,
        completed: 6,
        other: 2,
      },
      certificates: { issued: 5 },
      aiUsage: {
        conversations: 7,
        messages: 42,
        generatedQuizzes: 6,
        flashcards: 18,
        embeddings: 30,
      },
      classrooms: {
        total: 12,
        scheduled: 3,
        live: 1,
        ended: 8,
        cancelled: 0,
      },
      community: {
        posts: 15,
        comments: 28,
        reactions: 34,
      },
      library: {
        resources: 11,
        categories: 4,
        tags: 9,
        savedResources: 17,
      },
    });

    expect(prisma.user.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(prisma.user.count).toHaveBeenCalledTimes(3);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        roles: { some: { role: { name: RoleName.platform_admin } } },
      },
    });
    expect(prisma.course.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(prisma.enrollment.count).toHaveBeenNthCalledWith(1, {
      where: { status: 'active' },
    });
    expect(prisma.enrollment.count).toHaveBeenNthCalledWith(2, {
      where: { status: 'completed' },
    });
    expect(prisma.enrollment.count).toHaveBeenNthCalledWith(3, {
      where: { status: { notIn: ['active', 'completed'] } },
    });
    expect(prisma.classroomSession.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(prisma.communityReaction.count).toHaveBeenCalledWith({
      where: { post: { deletedAt: null } },
    });
    expect(prisma.savedResource.count).toHaveBeenCalledWith({
      where: { resource: { deletedAt: null } },
    });
  });

  it('returns zeroed enum buckets and derives explicit enrollment totals', async () => {
    const prisma = {
      user: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      course: { groupBy: jest.fn().mockResolvedValue([]) },
      enrollment: {
        count: jest
          .fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(0),
      },
      certificate: { count: jest.fn().mockResolvedValue(0) },
      aiConversation: { count: jest.fn().mockResolvedValue(0) },
      aiMessage: { count: jest.fn().mockResolvedValue(0) },
      aiGeneratedQuiz: { count: jest.fn().mockResolvedValue(0) },
      aiFlashcard: { count: jest.fn().mockResolvedValue(0) },
      aiEmbedding: { count: jest.fn().mockResolvedValue(0) },
      classroomSession: { groupBy: jest.fn().mockResolvedValue([]) },
      communityPost: { count: jest.fn().mockResolvedValue(0) },
      communityComment: { count: jest.fn().mockResolvedValue(0) },
      communityReaction: { count: jest.fn().mockResolvedValue(0) },
      libraryResource: { count: jest.fn().mockResolvedValue(0) },
      libraryCategory: { count: jest.fn().mockResolvedValue(0) },
      libraryTag: { count: jest.fn().mockResolvedValue(0) },
      savedResource: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new AdminService(prisma as never);

    const result = await service.getOverview();

    expect(result.users).toEqual({
      total: 0,
      active: 0,
      inactive: 0,
      suspended: 0,
    });
    expect(result.courses).toEqual({
      total: 0,
      draft: 0,
      published: 0,
      archived: 0,
    });
    expect(result.classrooms).toEqual({
      total: 0,
      scheduled: 0,
      live: 0,
      ended: 0,
      cancelled: 0,
    });
    expect(result.enrollments).toEqual({
      total: 2,
      active: 1,
      completed: 1,
      other: 0,
    });
  });
});
