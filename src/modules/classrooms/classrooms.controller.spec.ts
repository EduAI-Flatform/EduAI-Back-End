import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ClassroomsController } from './classrooms.controller';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const student = { id: 'student-id', roles: [RoleName.student] };

describe('ClassroomsController', () => {
  function createController() {
    const service = {
      createSession: jest.fn().mockResolvedValue({ id: 'session-id' }),
      listSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockResolvedValue({ id: 'session-id' }),
      updateSession: jest.fn().mockResolvedValue({ id: 'session-id' }),
      deleteSession: jest.fn().mockResolvedValue({ deleted: true }),
      startSession: jest.fn().mockResolvedValue({ meetingUrl: 'https://meet.jit.si/room' }),
      joinSession: jest.fn().mockResolvedValue({ meetingUrl: 'https://meet.jit.si/room' }),
      recordAttendance: jest.fn().mockResolvedValue({ id: 'attendance-id' }),
      addRecording: jest.fn().mockResolvedValue({ id: 'recording-id' }),
    };
    return { controller: new ClassroomsController(service as never), service };
  }

  it('delegates session operations with authenticated users', async () => {
    const { controller, service } = createController();
    const input = {
      title: 'Live AI Workshop',
      scheduledStart: '2026-07-10T08:00:00.000Z',
      scheduledEnd: '2026-07-10T09:00:00.000Z',
    };

    await controller.createSession(instructor, 'course-id', input);
    await controller.listSessions(student, 'course-id');
    await controller.getSession(student, 'session-id');
    await controller.updateSession(instructor, 'session-id', { title: 'Updated' });
    await controller.deleteSession(instructor, 'session-id');
    await controller.startSession(instructor, 'session-id');
    await controller.joinSession(student, 'session-id');
    await controller.recordAttendance(student, 'session-id', { event: 'join' });
    await controller.addRecording(instructor, 'session-id', {
      recordingUrl: 'https://recordings.example.com/session.mp4',
    });

    expect(service.createSession).toHaveBeenCalledWith(instructor, 'course-id', input);
    expect(service.listSessions).toHaveBeenCalledWith(student, 'course-id');
    expect(service.getSession).toHaveBeenCalledWith(student, 'session-id');
    expect(service.updateSession).toHaveBeenCalledWith(
      instructor,
      'session-id',
      { title: 'Updated' },
    );
    expect(service.deleteSession).toHaveBeenCalledWith(instructor, 'session-id');
    expect(service.startSession).toHaveBeenCalledWith(instructor, 'session-id');
    expect(service.joinSession).toHaveBeenCalledWith(student.id, 'session-id');
    expect(service.recordAttendance).toHaveBeenCalledWith(
      student.id,
      'session-id',
      { event: 'join' },
    );
    expect(service.addRecording).toHaveBeenCalledWith(
      instructor,
      'session-id',
      { recordingUrl: 'https://recordings.example.com/session.mp4' },
    );
  });

  it('requires guards and separates manager from student-visible routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ClassroomsController)).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.createSession,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.listSessions,
      ),
    ).toEqual([RoleName.student, RoleName.instructor, RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.updateSession,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.deleteSession,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.startSession,
      ),
    ).toEqual([RoleName.instructor]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.joinSession,
      ),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.recordAttendance,
      ),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ClassroomsController.prototype.addRecording,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
  });
});
