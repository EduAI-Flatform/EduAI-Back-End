import { Injectable } from '@nestjs/common';
import {
  ClassroomSessionStatus,
  CourseStatus,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

interface StatusCount<TStatus extends string> {
  status: TStatus;
  _count: { _all: number };
}

export interface AdminOverviewResponse {
  users: {
    total: number;
    active: number;
    inactive: number;
    suspended: number;
  };
  roles: {
    student: number;
    instructor: number;
    platformAdmin: number;
  };
  courses: {
    total: number;
    draft: number;
    published: number;
    archived: number;
  };
  enrollments: {
    total: number;
    active: number;
    completed: number;
    other: number;
  };
  certificates: { issued: number };
  aiUsage: {
    conversations: number;
    messages: number;
    generatedQuizzes: number;
    flashcards: number;
    embeddings: number;
  };
  classrooms: {
    total: number;
    scheduled: number;
    live: number;
    ended: number;
    cancelled: number;
  };
  community: {
    posts: number;
    comments: number;
    reactions: number;
  };
  library: {
    resources: number;
    categories: number;
    tags: number;
    savedResources: number;
  };
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(): Promise<AdminOverviewResponse> {
    const [
      userStatusCounts,
      studentRoles,
      instructorRoles,
      platformAdminRoles,
      courseStatusCounts,
      activeEnrollments,
      completedEnrollments,
      otherEnrollments,
      issuedCertificates,
      aiConversations,
      aiMessages,
      generatedQuizzes,
      flashcards,
      embeddings,
      classroomStatusCounts,
      communityPosts,
      communityComments,
      communityReactions,
      libraryResources,
      libraryCategories,
      libraryTags,
      savedResources,
    ] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.countUsersWithRole(RoleName.student),
      this.countUsersWithRole(RoleName.instructor),
      this.countUsersWithRole(RoleName.platform_admin),
      this.prisma.course.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.enrollment.count({ where: { status: 'active' } }),
      this.prisma.enrollment.count({ where: { status: 'completed' } }),
      this.prisma.enrollment.count({
        where: { status: { notIn: ['active', 'completed'] } },
      }),
      this.prisma.certificate.count(),
      this.prisma.aiConversation.count(),
      this.prisma.aiMessage.count(),
      this.prisma.aiGeneratedQuiz.count(),
      this.prisma.aiFlashcard.count(),
      this.prisma.aiEmbedding.count(),
      this.prisma.classroomSession.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.communityPost.count({ where: { deletedAt: null } }),
      this.prisma.communityComment.count({
        where: { deletedAt: null, post: { deletedAt: null } },
      }),
      this.prisma.communityReaction.count({
        where: { post: { deletedAt: null } },
      }),
      this.prisma.libraryResource.count({ where: { deletedAt: null } }),
      this.prisma.libraryCategory.count(),
      this.prisma.libraryTag.count(),
      this.prisma.savedResource.count({
        where: { resource: { deletedAt: null } },
      }),
    ]);

    return {
      users: {
        total: this.total(userStatusCounts),
        active: this.count(userStatusCounts, UserStatus.active),
        inactive: this.count(userStatusCounts, UserStatus.inactive),
        suspended: this.count(userStatusCounts, UserStatus.suspended),
      },
      roles: {
        student: studentRoles,
        instructor: instructorRoles,
        platformAdmin: platformAdminRoles,
      },
      courses: {
        total: this.total(courseStatusCounts),
        draft: this.count(courseStatusCounts, CourseStatus.draft),
        published: this.count(courseStatusCounts, CourseStatus.published),
        archived: this.count(courseStatusCounts, CourseStatus.archived),
      },
      enrollments: {
        total: activeEnrollments + completedEnrollments + otherEnrollments,
        active: activeEnrollments,
        completed: completedEnrollments,
        other: otherEnrollments,
      },
      certificates: { issued: issuedCertificates },
      aiUsage: {
        conversations: aiConversations,
        messages: aiMessages,
        generatedQuizzes,
        flashcards,
        embeddings,
      },
      classrooms: {
        total: this.total(classroomStatusCounts),
        scheduled: this.count(
          classroomStatusCounts,
          ClassroomSessionStatus.scheduled,
        ),
        live: this.count(classroomStatusCounts, ClassroomSessionStatus.live),
        ended: this.count(classroomStatusCounts, ClassroomSessionStatus.ended),
        cancelled: this.count(
          classroomStatusCounts,
          ClassroomSessionStatus.cancelled,
        ),
      },
      community: {
        posts: communityPosts,
        comments: communityComments,
        reactions: communityReactions,
      },
      library: {
        resources: libraryResources,
        categories: libraryCategories,
        tags: libraryTags,
        savedResources,
      },
    };
  }

  private countUsersWithRole(role: RoleName): Promise<number> {
    return this.prisma.user.count({
      where: {
        deletedAt: null,
        roles: { some: { role: { name: role } } },
      },
    });
  }

  private count<TStatus extends string>(
    counts: StatusCount<TStatus>[],
    status: TStatus,
  ): number {
    return counts.find((entry) => entry.status === status)?._count._all ?? 0;
  }

  private total<TStatus extends string>(
    counts: StatusCount<TStatus>[],
  ): number {
    return counts.reduce((total, entry) => total + entry._count._all, 0);
  }
}
