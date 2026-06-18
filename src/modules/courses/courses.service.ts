import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Course,
  CourseStatus,
  CourseVisibility,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

type CourseWithLessonCount = Course & {
  _count: {
    lessons: number;
  };
};

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async listCourses(): Promise<Course[]> {
    return this.prisma.course.findMany({
      where: {
        deletedAt: null,
        status: CourseStatus.published,
        visibility: CourseVisibility.public,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createCourse(
    user: AuthenticatedUser,
    input: CreateCourseDto,
  ): Promise<Course> {
    this.assertCanCreateCourse(user);

    try {
      return await this.prisma.course.create({
        data: {
          instructorId: user.id,
          title: input.title,
          slug: input.slug,
          description: input.description,
          thumbnailUrl: input.thumbnailUrl,
          level: input.level,
          status: CourseStatus.draft,
          visibility: input.visibility ?? CourseVisibility.public,
        },
      });
    } catch (error) {
      if (this.isCourseSlugConflict(error)) {
        throw new ConflictException('Course slug is already in use');
      }

      throw error;
    }
  }

  async updateCourse(
    user: AuthenticatedUser,
    courseId: string,
    input: UpdateCourseDto,
  ): Promise<Course> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    if (input.status !== undefined) {
      throw new BadRequestException(
        'Use publish or archive course endpoints to change status',
      );
    }

    const data = this.removeUndefinedFields({
      title: input.title,
      slug: input.slug,
      description: input.description,
      thumbnailUrl: input.thumbnailUrl,
      level: input.level,
      visibility: input.visibility,
    });

    try {
      return await this.prisma.course.update({
        where: { id: courseId },
        data,
      });
    } catch (error) {
      if (this.isCourseSlugConflict(error)) {
        throw new ConflictException('Course slug is already in use');
      }

      throw error;
    }
  }

  async publishCourse(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<Course> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    if (course._count.lessons < 1) {
      throw new BadRequestException(
        'Course must have at least one lesson before publication',
      );
    }

    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.published,
      },
    });
  }

  async archiveCourse(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<Course> {
    const course = await this.findCourseOrThrow(courseId);
    this.assertCanManageCourse(user, course);

    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.archived,
      },
    });
  }

  async getCourse(
    courseId: string,
    user?: AuthenticatedUser,
  ): Promise<CourseWithLessonCount> {
    const course = await this.findCourseOrThrow(courseId);

    if (
      course.status === CourseStatus.published &&
      course.visibility === CourseVisibility.public
    ) {
      return course;
    }

    if (user && this.canManageCourse(user, course)) {
      return course;
    }

    throw new NotFoundException('Course not found');
  }

  private async findCourseOrThrow(courseId: string): Promise<CourseWithLessonCount> {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            lessons: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private assertCanCreateCourse(user: AuthenticatedUser): void {
    if (
      !this.hasRole(user, RoleName.instructor) &&
      !this.hasRole(user, RoleName.platform_admin)
    ) {
      throw new ForbiddenException('Only instructors or admins can create courses');
    }
  }

  private assertCanManageCourse(
    user: AuthenticatedUser,
    course: Pick<Course, 'instructorId'>,
  ): void {
    if (!this.canManageCourse(user, course)) {
      throw new NotFoundException('Course not found');
    }
  }

  private canManageCourse(
    user: AuthenticatedUser,
    course: Pick<Course, 'instructorId'>,
  ): boolean {
    return (
      this.hasRole(user, RoleName.platform_admin) ||
      (this.hasRole(user, RoleName.instructor) && course.instructorId === user.id)
    );
  }

  private hasRole(user: AuthenticatedUser, role: RoleName): boolean {
    return user.roles.includes(role);
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private isCourseSlugConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('slug')
    );
  }
}
