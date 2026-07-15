import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ClassroomSessionStatus,
  CourseStatus,
  Prisma,
  RoleName,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateClassroomRecordingDto } from './dto/create-classroom-recording.dto';
import { CreateClassroomSessionDto } from './dto/create-classroom-session.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { UpdateClassroomSessionDto } from './dto/update-classroom-session.dto';
import { JitsiRoomService } from './jitsi-room.service';

const classroomSessionResponseSelect = {
  id: true,
  courseId: true,
  title: true,
  description: true,
  provider: true,
  meetingUrl: true,
  roomName: true,
  scheduledStart: true,
  scheduledEnd: true,
  actualStart: true,
  actualEnd: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClassroomSessionSelect;

export type ClassroomSessionResponse = Prisma.ClassroomSessionGetPayload<{
  select: typeof classroomSessionResponseSelect;
}>;

export interface DeletedClassroomSessionResponse {
  deleted: true;
}

export interface StartedClassroomSessionResponse {
  id: string;
  roomName: string;
  meetingUrl: string;
  status: ClassroomSessionStatus;
  actualStart: Date | null;
}

export interface JoinedClassroomSessionResponse {
  id: string;
  roomName: string;
  meetingUrl: string;
}

const classroomAttendanceResponseSelect = {
  id: true,
  sessionId: true,
  userId: true,
  joinedAt: true,
  leftAt: true,
  durationSeconds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClassroomAttendanceSelect;

export type ClassroomAttendanceResponse = Prisma.ClassroomAttendanceGetPayload<{
  select: typeof classroomAttendanceResponseSelect;
}>;

const classroomRecordingResponseSelect = {
  id: true,
  sessionId: true,
  recordingUrl: true,
  durationSeconds: true,
  createdAt: true,
} satisfies Prisma.ClassroomRecordingSelect;

export type ClassroomRecordingResponse = Prisma.ClassroomRecordingGetPayload<{
  select: typeof classroomRecordingResponseSelect;
}>;

type ManageableCourse = {
  id: string;
  instructorId: string;
};

type ManageableSession = ClassroomSessionResponse & {
  course: { instructorId: string };
};

@Injectable()
export class ClassroomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jitsiRooms: JitsiRoomService,
  ) {}

  async createSession(
    user: AuthenticatedUser,
    courseId: string,
    input: CreateClassroomSessionDto,
  ): Promise<ClassroomSessionResponse> {
    const course = await this.findManageableCourseOrThrow(user, courseId);
    this.assertValidSchedule(input.scheduledStart, input.scheduledEnd);
    const roomName = this.jitsiRooms.generateRoomName(courseId, input.title);

    return this.prisma.classroomSession.create({
      data: {
        courseId,
        instructorId: course.instructorId,
        title: input.title,
        description: input.description,
        provider: 'jitsi',
        meetingUrl: null,
        roomName,
        scheduledStart: new Date(input.scheduledStart),
        scheduledEnd: new Date(input.scheduledEnd),
        status: ClassroomSessionStatus.scheduled,
      },
      select: classroomSessionResponseSelect,
    });
  }

  async listSessions(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<ClassroomSessionResponse[]> {
    await this.resolveCourseAccess(user, courseId);

    return this.prisma.classroomSession.findMany({
      where: { courseId, deletedAt: null },
      orderBy: { scheduledStart: 'asc' },
      select: classroomSessionResponseSelect,
    });
  }

  async getSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ClassroomSessionResponse> {
    const session = await this.prisma.classroomSession.findFirst({
      where: { id: sessionId, deletedAt: null },
      select: {
        ...classroomSessionResponseSelect,
        course: {
          select: {
            instructorId: true,
            status: true,
            deletedAt: true,
            enrollments: {
              where: { userId: user.id },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    const canManage = session && this.canManage(user, session.course.instructorId);
    const canStudy = Boolean(
      session &&
        user.roles.includes(RoleName.student) &&
        session.course.status === CourseStatus.published &&
        !session.course.deletedAt &&
        session.course.enrollments.length > 0,
    );

    if (!session || (!canManage && !canStudy)) {
      throw new NotFoundException('Classroom session not found');
    }

    const { course: _course, ...response } = session;
    return response;
  }

  async updateSession(
    user: AuthenticatedUser,
    sessionId: string,
    input: UpdateClassroomSessionDto,
  ): Promise<ClassroomSessionResponse> {
    const session = await this.findManageableSessionOrThrow(user, sessionId);
    if (input.scheduledStart || input.scheduledEnd) {
      this.assertValidSchedule(
        input.scheduledStart ?? session.scheduledStart.toISOString(),
        input.scheduledEnd ?? session.scheduledEnd.toISOString(),
      );
    }

    return this.prisma.classroomSession.update({
      where: { id: sessionId },
      data: this.removeUndefinedFields({
        title: input.title,
        description: input.description,
        scheduledStart: this.toOptionalRequiredDate(input.scheduledStart),
        scheduledEnd: this.toOptionalRequiredDate(input.scheduledEnd),
      }),
      select: classroomSessionResponseSelect,
    });
  }

  async deleteSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<DeletedClassroomSessionResponse> {
    await this.findManageableSessionOrThrow(user, sessionId);

    await this.prisma.classroomSession.update({
      where: { id: sessionId },
      data: {
        deletedAt: new Date(),
        status: ClassroomSessionStatus.cancelled,
      },
    });

    return { deleted: true };
  }

  async startSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<StartedClassroomSessionResponse> {
    const session = await this.findStartableSessionOrThrow(user, sessionId);
    const actualStart = new Date();
    const startedSession = await this.prisma.classroomSession.update({
      where: { id: session.id },
      data: {
        actualStart,
        status: ClassroomSessionStatus.live,
        meetingUrl: null,
      },
      select: {
        id: true,
        roomName: true,
        status: true,
        actualStart: true,
      },
    });

    return {
      ...startedSession,
      meetingUrl: this.jitsiRooms.buildMeetingUrl(startedSession.roomName),
    };
  }

  async joinSession(
    userId: string,
    sessionId: string,
  ): Promise<JoinedClassroomSessionResponse> {
    const session = await this.prisma.classroomSession.findFirst({
      where: {
        id: sessionId,
        deletedAt: null,
        status: ClassroomSessionStatus.live,
        course: {
          deletedAt: null,
          status: CourseStatus.published,
          enrollments: { some: { userId } },
        },
      },
      select: {
        id: true,
        roomName: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Classroom session not found');
    }

    return {
      ...session,
      meetingUrl: this.jitsiRooms.buildMeetingUrl(session.roomName),
    };
  }

  async recordAttendance(
    userId: string,
    sessionId: string,
    input: RecordAttendanceDto,
  ): Promise<ClassroomAttendanceResponse> {
    await this.findJoinableSessionOrThrow(userId, sessionId);

    if (input.event === 'join') {
      return this.recordJoin(userId, sessionId);
    }

    return this.recordLeave(userId, sessionId);
  }

  async addRecording(
    user: AuthenticatedUser,
    sessionId: string,
    input: CreateClassroomRecordingDto,
  ): Promise<ClassroomRecordingResponse> {
    await this.findManageableSessionOrThrow(user, sessionId);

    return this.prisma.classroomRecording.create({
      data: {
        sessionId,
        recordingUrl: input.recordingUrl,
        durationSeconds: input.durationSeconds,
      },
      select: classroomRecordingResponseSelect,
    });
  }

  private async findManageableCourseOrThrow(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<ManageableCourse> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true, instructorId: true },
    });

    if (!course || !this.canManage(user, course.instructorId)) {
      throw new NotFoundException('Course not found');
    }

    return course;
  }

  private async findJoinableSessionOrThrow(
    userId: string,
    sessionId: string,
  ): Promise<{ id: string }> {
    const session = await this.prisma.classroomSession.findFirst({
      where: {
        id: sessionId,
        deletedAt: null,
        status: ClassroomSessionStatus.live,
        course: {
          deletedAt: null,
          status: CourseStatus.published,
          enrollments: { some: { userId } },
        },
      },
      select: { id: true },
    });

    if (!session) {
      throw new NotFoundException('Classroom session not found');
    }

    return session;
  }

  private recordJoin(
    userId: string,
    sessionId: string,
  ): Promise<ClassroomAttendanceResponse> {
    const now = new Date();

    return this.prisma.classroomAttendance.upsert({
      where: {
        sessionId_userId: {
          sessionId,
          userId,
        },
      },
      create: {
        sessionId,
        userId,
        joinedAt: now,
      },
      update: {
        joinedAt: now,
        leftAt: null,
        durationSeconds: null,
      },
      select: classroomAttendanceResponseSelect,
    });
  }

  private async recordLeave(
    userId: string,
    sessionId: string,
  ): Promise<ClassroomAttendanceResponse> {
    const existingAttendance = await this.prisma.classroomAttendance.findFirst({
      where: { sessionId, userId },
      select: { id: true, joinedAt: true },
    });

    if (!existingAttendance) {
      throw new NotFoundException('Classroom attendance not found');
    }

    const now = new Date();
    const durationSeconds = Math.max(
      0,
      Math.floor((now.getTime() - existingAttendance.joinedAt.getTime()) / 1000),
    );

    return this.prisma.classroomAttendance.update({
      where: {
        sessionId_userId: {
          sessionId,
          userId,
        },
      },
      data: {
        leftAt: now,
        durationSeconds,
      },
      select: classroomAttendanceResponseSelect,
    });
  }

  private async resolveCourseAccess(
    user: AuthenticatedUser,
    courseId: string,
  ): Promise<'manager' | 'student'> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: {
        id: true,
        instructorId: true,
        status: true,
        enrollments: {
          where: { userId: user.id },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (course && this.canManage(user, course.instructorId)) return 'manager';
    if (
      course &&
      user.roles.includes(RoleName.student) &&
      course.status === CourseStatus.published &&
      course.enrollments.length > 0
    ) {
      return 'student';
    }

    throw new NotFoundException('Course not found');
  }

  private async findManageableSessionOrThrow(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ManageableSession> {
    const session = await this.prisma.classroomSession.findFirst({
      where: { id: sessionId, deletedAt: null },
      select: {
        ...classroomSessionResponseSelect,
        course: { select: { instructorId: true } },
      },
    });

    if (!session || !this.canManage(user, session.course.instructorId)) {
      throw new NotFoundException('Classroom session not found');
    }

    return session;
  }

  private async findStartableSessionOrThrow(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ClassroomSessionResponse & { course: { instructorId: string } }> {
    const session = await this.prisma.classroomSession.findFirst({
      where: { id: sessionId, deletedAt: null },
      select: {
        ...classroomSessionResponseSelect,
        course: { select: { instructorId: true } },
      },
    });

    if (
      !session ||
      !user.roles.includes(RoleName.instructor) ||
      session.course.instructorId !== user.id
    ) {
      throw new NotFoundException('Classroom session not found');
    }

    return session;
  }

  private canManage(user: AuthenticatedUser, instructorId: string): boolean {
    return (
      user.roles.includes(RoleName.platform_admin) ||
      (user.roles.includes(RoleName.instructor) && user.id === instructorId)
    );
  }

  private assertValidSchedule(
    scheduledStart?: string,
    scheduledEnd?: string,
  ): void {
    if (!scheduledStart || !scheduledEnd) return;

    if (new Date(scheduledStart) >= new Date(scheduledEnd)) {
      throw new BadRequestException('scheduledEnd must be after scheduledStart');
    }
  }

  private removeUndefinedFields<T extends object>(input: T): T {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }

  private toOptionalRequiredDate(value: string | undefined): Date | undefined {
    if (value === undefined) return undefined;
    return new Date(value);
  }
}
