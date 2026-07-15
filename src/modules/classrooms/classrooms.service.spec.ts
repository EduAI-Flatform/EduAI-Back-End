import { NotFoundException } from '@nestjs/common';
import {
  ClassroomSessionStatus,
  CourseStatus,
  RoleName,
} from '../../../generated/prisma/client';
import { ClassroomsService } from './classrooms.service';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const admin = { id: 'admin-id', roles: [RoleName.platform_admin] };
const student = { id: 'student-id', roles: [RoleName.student] };
const course = {
  id: 'course-id',
  instructorId: instructor.id,
  status: CourseStatus.published,
  enrollments: [{ id: 'enrollment-id' }],
};
const scheduledStart = new Date('2026-07-10T08:00:00.000Z');
const scheduledEnd = new Date('2026-07-10T09:00:00.000Z');
const serverNow = new Date('2026-07-10T08:15:30.000Z');
const classroomSession = {
  id: 'session-id',
  courseId: course.id,
  title: 'Live AI Workshop',
  description: null,
  provider: 'jitsi',
  meetingUrl: 'https://meet.jit.si/live-ai-workshop',
  roomName: 'live-ai-workshop',
  scheduledStart,
  scheduledEnd,
  actualStart: null,
  actualEnd: null,
  status: ClassroomSessionStatus.scheduled,
  createdAt: scheduledStart,
  updatedAt: scheduledStart,
};

function createService() {
  const jitsiRooms = {
    generateRoomName: jest.fn().mockReturnValue('eduai-course-live-ai-workshop-token'),
    buildMeetingUrl: jest
      .fn()
      .mockImplementation((roomName: string) => `https://meet.jit.si/${roomName}`),
  };
  const prisma = {
    course: {
      findFirst: jest.fn().mockResolvedValue(course),
    },
    classroomSession: {
      create: jest.fn().mockResolvedValue(classroomSession),
      findFirst: jest.fn().mockResolvedValue({
        ...classroomSession,
        course,
      }),
      findMany: jest.fn().mockResolvedValue([classroomSession]),
      update: jest.fn().mockResolvedValue({
        ...classroomSession,
        status: ClassroomSessionStatus.live,
        actualStart: scheduledStart,
      }),
    },
    classroomAttendance: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'attendance-id',
        sessionId: classroomSession.id,
        userId: student.id,
        joinedAt: scheduledStart,
      }),
      upsert: jest.fn().mockResolvedValue({
        id: 'attendance-id',
        sessionId: classroomSession.id,
        userId: student.id,
        joinedAt: serverNow,
        leftAt: null,
        durationSeconds: null,
        createdAt: serverNow,
        updatedAt: serverNow,
      }),
      update: jest.fn().mockResolvedValue({
        id: 'attendance-id',
        sessionId: classroomSession.id,
        userId: student.id,
        joinedAt: scheduledStart,
        leftAt: serverNow,
        durationSeconds: 930,
        createdAt: scheduledStart,
        updatedAt: serverNow,
      }),
    },
    classroomRecording: {
      create: jest.fn().mockResolvedValue({
        id: 'recording-id',
        sessionId: classroomSession.id,
        recordingUrl: 'https://recordings.example.com/session.mp4',
        durationSeconds: 3600,
        createdAt: serverNow,
      }),
    },
  };
  return {
    prisma,
    jitsiRooms,
    service: new ClassroomsService(prisma as never, jitsiRooms as never),
  };
}

describe('ClassroomsService', () => {
  it('creates scheduled sessions for the owning instructor', async () => {
    const { prisma, service } = createService();

    await service.createSession(instructor, course.id, {
      title: classroomSession.title,
      scheduledStart: scheduledStart.toISOString(),
      scheduledEnd: scheduledEnd.toISOString(),
    });

    expect(prisma.classroomSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        courseId: course.id,
        instructorId: instructor.id,
        provider: 'jitsi',
        roomName: 'eduai-course-live-ai-workshop-token',
        meetingUrl: null,
        status: ClassroomSessionStatus.scheduled,
      }),
      select: expect.any(Object),
    });
  });

  it('hides courses from non-owning instructors when creating sessions', async () => {
    const { prisma, service } = createService();
    const otherInstructor = { id: 'other-instructor-id', roles: [RoleName.instructor] };

    await expect(
      service.createSession(otherInstructor, course.id, {
        title: classroomSession.title,
        scheduledStart: scheduledStart.toISOString(),
        scheduledEnd: scheduledEnd.toISOString(),
      }),
    ).rejects.toEqual(new NotFoundException('Course not found'));
    expect(prisma.classroomSession.create).not.toHaveBeenCalled();
  });

  it('lists sessions for enrolled students', async () => {
    const { prisma, service } = createService();

    await expect(service.listSessions(student, course.id)).resolves.toEqual([
      classroomSession,
    ]);
    expect(prisma.classroomSession.findMany).toHaveBeenCalledWith({
      where: { courseId: course.id, deletedAt: null },
      orderBy: { scheduledStart: 'asc' },
      select: expect.any(Object),
    });
  });

  it('rejects listing for students without enrollment', async () => {
    const { prisma, service } = createService();
    prisma.course.findFirst.mockResolvedValue({
      ...course,
      enrollments: [],
    });

    await expect(service.listSessions(student, course.id)).rejects.toEqual(
      new NotFoundException('Course not found'),
    );
    expect(prisma.classroomSession.findMany).not.toHaveBeenCalled();
  });

  it('updates and soft-deletes owned sessions', async () => {
    const { prisma, service } = createService();

    await service.updateSession(admin, classroomSession.id, {
      title: 'Updated session',
    });
    await service.deleteSession(instructor, classroomSession.id);

    expect(prisma.classroomSession.update).toHaveBeenNthCalledWith(1, {
      where: { id: classroomSession.id },
      data: { title: 'Updated session' },
      select: expect.any(Object),
    });
    expect(prisma.classroomSession.update).toHaveBeenNthCalledWith(2, {
      where: { id: classroomSession.id },
      data: expect.objectContaining({
        status: ClassroomSessionStatus.cancelled,
      }),
    });
  });

  it('starts sessions only for the owning instructor and returns an ephemeral URL', async () => {
    const { prisma, service } = createService();

    await expect(service.startSession(instructor, classroomSession.id)).resolves.toEqual(
      expect.objectContaining({
        id: classroomSession.id,
        roomName: classroomSession.roomName,
        meetingUrl: `https://meet.jit.si/${classroomSession.roomName}`,
        status: ClassroomSessionStatus.live,
      }),
    );
    expect(prisma.classroomSession.update).toHaveBeenCalledWith({
      where: { id: classroomSession.id },
      data: expect.objectContaining({
        actualStart: expect.any(Date),
        status: ClassroomSessionStatus.live,
        meetingUrl: null,
      }),
      select: expect.any(Object),
    });

    await expect(service.startSession(admin, classroomSession.id)).rejects.toEqual(
      new NotFoundException('Classroom session not found'),
    );
  });

  it('lets enrolled students join live sessions without storing a permanent link', async () => {
    const { prisma, service } = createService();
    prisma.classroomSession.findFirst.mockResolvedValueOnce({
      id: classroomSession.id,
      roomName: classroomSession.roomName,
    });

    await expect(service.joinSession(student.id, classroomSession.id)).resolves.toEqual(
      {
        id: classroomSession.id,
        roomName: classroomSession.roomName,
        meetingUrl: `https://meet.jit.si/${classroomSession.roomName}`,
      },
    );
  });

  it('rejects non-enrolled students and non-live sessions when joining', async () => {
    const { prisma, service } = createService();
    prisma.classroomSession.findFirst.mockResolvedValueOnce(null);
    await expect(service.joinSession(student.id, classroomSession.id)).rejects.toEqual(
      new NotFoundException('Classroom session not found'),
    );

    prisma.classroomSession.findFirst.mockResolvedValueOnce(null);
    await expect(service.joinSession(student.id, classroomSession.id)).rejects.toEqual(
      new NotFoundException('Classroom session not found'),
    );
  });

  it('records join attendance with server-side timestamps and one row per session user', async () => {
    jest.useFakeTimers().setSystemTime(serverNow);
    const { prisma, service } = createService();

    await expect(
      service.recordAttendance(student.id, classroomSession.id, { event: 'join' }),
    ).resolves.toEqual(expect.objectContaining({
      sessionId: classroomSession.id,
      userId: student.id,
      joinedAt: serverNow,
      leftAt: null,
      durationSeconds: null,
    }));

    expect(prisma.classroomAttendance.upsert).toHaveBeenCalledWith({
      where: {
        sessionId_userId: {
          sessionId: classroomSession.id,
          userId: student.id,
        },
      },
      create: expect.objectContaining({
        sessionId: classroomSession.id,
        userId: student.id,
        joinedAt: serverNow,
      }),
      update: expect.objectContaining({
        joinedAt: serverNow,
        leftAt: null,
        durationSeconds: null,
      }),
      select: expect.any(Object),
    });
    jest.useRealTimers();
  });

  it('records leave attendance and calculates duration on the server', async () => {
    jest.useFakeTimers().setSystemTime(serverNow);
    const { prisma, service } = createService();

    await expect(
      service.recordAttendance(student.id, classroomSession.id, { event: 'leave' }),
    ).resolves.toEqual(expect.objectContaining({
      leftAt: serverNow,
      durationSeconds: 930,
    }));

    expect(prisma.classroomAttendance.update).toHaveBeenCalledWith({
      where: {
        sessionId_userId: {
          sessionId: classroomSession.id,
          userId: student.id,
        },
      },
      data: {
        leftAt: serverNow,
        durationSeconds: 930,
      },
      select: expect.any(Object),
    });
    jest.useRealTimers();
  });

  it('rejects attendance for sessions the student cannot join', async () => {
    const { prisma, service } = createService();
    prisma.classroomSession.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.recordAttendance(student.id, classroomSession.id, { event: 'join' }),
    ).rejects.toEqual(new NotFoundException('Classroom session not found'));
    expect(prisma.classroomAttendance.upsert).not.toHaveBeenCalled();
  });

  it('adds recording metadata for a manageable classroom session', async () => {
    const { prisma, service } = createService();

    await expect(
      service.addRecording(instructor, classroomSession.id, {
        recordingUrl: 'https://recordings.example.com/session.mp4',
        durationSeconds: 3600,
      }),
    ).resolves.toEqual(expect.objectContaining({
      id: 'recording-id',
      sessionId: classroomSession.id,
      recordingUrl: 'https://recordings.example.com/session.mp4',
      durationSeconds: 3600,
    }));

    expect(prisma.classroomRecording.create).toHaveBeenCalledWith({
      data: {
        sessionId: classroomSession.id,
        recordingUrl: 'https://recordings.example.com/session.mp4',
        durationSeconds: 3600,
      },
      select: expect.any(Object),
    });
  });

  it('hides recording creation from non-owning instructors', async () => {
    const { prisma, service } = createService();
    const otherInstructor = { id: 'other-instructor-id', roles: [RoleName.instructor] };

    await expect(
      service.addRecording(otherInstructor, classroomSession.id, {
        recordingUrl: 'https://recordings.example.com/session.mp4',
      }),
    ).rejects.toEqual(new NotFoundException('Classroom session not found'));
    expect(prisma.classroomRecording.create).not.toHaveBeenCalled();
  });
});
