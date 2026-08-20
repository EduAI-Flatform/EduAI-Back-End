import { NotFoundException } from '@nestjs/common';
import { MentorBookingStatus, RoleName } from '../../../generated/prisma/client';
import { MentorSessionsService } from './mentor-sessions.service';

describe('MentorSessionsService', () => {
  const joinedAt = new Date('2030-01-01T09:00:00.000Z');
  const leftAt = new Date('2030-01-01T10:00:00.000Z');
  const booking = {
    id: 'booking-id',
    topic: 'Career planning',
    studentId: 'student-id',
    mentorProfile: { userId: 'mentor-id' },
    status: MentorBookingStatus.accepted,
  };
  const session = { id: 'session-id', roomName: 'private-room' };
  const attendance = { joinedAt, leftAt: null, durationSeconds: null };
  const prisma: any = {
    mentorBooking: { findFirst: jest.fn() },
    mentorSession: { upsert: jest.fn(), findUnique: jest.fn() },
    mentorSessionAttendance: { upsert: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const rooms = {
    generateRoomName: jest.fn().mockReturnValue('private-room'),
    buildMeetingUrl: jest.fn().mockReturnValue('https://meet.jit.si/private-room'),
  };
  let service: MentorSessionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((operation: any) => operation(prisma));
    prisma.mentorBooking.findFirst.mockResolvedValue(booking);
    prisma.mentorSession.upsert.mockResolvedValue(session);
    prisma.mentorSession.findUnique.mockResolvedValue(session);
    prisma.mentorSessionAttendance.upsert.mockResolvedValue(attendance);
    prisma.mentorSessionAttendance.findUnique.mockResolvedValue(attendance);
    prisma.mentorSessionAttendance.findUniqueOrThrow.mockResolvedValue(attendance);
    prisma.mentorSessionAttendance.updateMany.mockResolvedValue({ count: 1 });
    service = new MentorSessionsService(prisma, rooms as never);
  });

  it('creates a private room and idempotent attendance for an accepted participant', async () => {
    await expect(service.join({ id: 'student-id', roles: [RoleName.student] }, 'booking-id')).resolves.toEqual({
      meetingUrl: 'https://meet.jit.si/private-room',
      joinedAt,
      leftAt: null,
    });
    expect(prisma.mentorBooking.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: MentorBookingStatus.accepted, OR: expect.any(Array) }) }));
    expect(prisma.mentorSessionAttendance.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it('allows an administrator without exposing participant predicates', async () => {
    await service.join({ id: 'admin-id', roles: [RoleName.platform_admin] }, 'booking-id');
    expect(prisma.mentorBooking.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'booking-id', status: MentorBookingStatus.accepted } }));
  });

  it('hides rooms from non-participants and non-accepted bookings', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValue(null);
    await expect(service.join({ id: 'outsider-id', roles: [RoleName.student] }, 'booking-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.mentorSession.upsert).not.toHaveBeenCalled();
  });

  it('records leave once and returns the canonical attendance on repeated leave', async () => {
    prisma.mentorSessionAttendance.findUnique.mockResolvedValue({ ...attendance, leftAt, durationSeconds: 3600 });
    prisma.mentorSessionAttendance.findUniqueOrThrow.mockResolvedValue({ ...attendance, leftAt, durationSeconds: 3600 });
    await expect(service.leave({ id: 'student-id', roles: [RoleName.student] }, 'booking-id')).resolves.toEqual({ joinedAt, leftAt, durationSeconds: 3600 });
    expect(prisma.mentorSessionAttendance.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ leftAt: null }) }));
  });
});
