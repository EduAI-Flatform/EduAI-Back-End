import { Injectable } from '@nestjs/common';
import {
  CourseVisibility,
  ModerationStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CourseAccessService } from '../access/course-access.service';
import {
  AiSourceType,
  ListAiSourcesQueryDto,
} from './dto/list-ai-sources-query.dto';

const MAX_SOURCES = 50;

export interface AiSourceResponse {
  sourceType: AiSourceType;
  sourceId: string;
  title: string;
  description: string | null;
  courseId?: string;
}

@Injectable()
export class AiSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseAccess: CourseAccessService,
  ) {}

  async listSources(
    user: AuthenticatedUser,
    query: ListAiSourcesQueryDto,
  ): Promise<AiSourceResponse[]> {
    const includeLessons =
      query.sourceType === undefined || query.sourceType === 'lesson';
    const includeLibrary =
      query.sourceType === undefined || query.sourceType === 'library_resource';
    const isAdmin = user.roles.includes(RoleName.platform_admin);

    const [lessons, resources] = await Promise.all([
      includeLessons
        ? this.prisma.lesson.findMany({
            where: {
              deletedAt: null,
              ...(query.search
                ? {
                    title: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  }
                : {}),
              course: {
                deletedAt: null,
              },
            },
            orderBy: { title: 'asc' },
            take: MAX_SOURCES * 4,
            select: {
              id: true,
              title: true,
              isPreview: true,
              course: {
                select: {
                  id: true,
                  title: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      includeLibrary
        ? this.prisma.libraryResource.findMany({
            where: {
              deletedAt: null,
              ...(query.search
                ? {
                    title: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  }
                : {}),
              ...(isAdmin
                ? {}
                : {
                    OR: [
                      { ownerId: user.id },
                      {
                        visibility: CourseVisibility.public,
                        moderationStatus: ModerationStatus.clear,
                      },
                    ],
                  }),
            },
            orderBy: { title: 'asc' },
            take: MAX_SOURCES,
            select: {
              id: true,
              title: true,
              description: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const accessibleLessons = (
      await Promise.all(lessons.map(async (lesson) => ({
        lesson,
        decision: await this.courseAccess.decideContent({
          user,
          courseId: lesson.course.id,
          isPreviewResource: lesson.isPreview,
        }),
      })))
    ).filter(({ decision }) => decision.allowed).map(({ lesson }) => lesson);

    return [
      ...accessibleLessons.map((lesson) => ({
        sourceType: 'lesson' as const,
        sourceId: lesson.id,
        title: lesson.title,
        description: lesson.course.title,
        courseId: lesson.course.id,
      })),
      ...resources.map((resource) => ({
        sourceType: 'library_resource' as const,
        sourceId: resource.id,
        title: resource.title,
        description: resource.description,
      })),
    ]
      .sort((left, right) => left.title.localeCompare(right.title, 'vi'))
      .slice(0, MAX_SOURCES);
  }
}
