import { BadRequestException, ConflictException } from '@nestjs/common';
import { MentorBookingStatus, Prisma } from '../../../generated/prisma/client';
import { MentorBookingsService } from './mentor-bookings.service';

describe('MentorBookingsService', () => {
  const start = new Date('2030-01-01T09:00:00.000Z');
  const end = new Date('2030-01-01T10:00:00.000Z');
  const booking = { id: 'booking-id', topic: 'Career planning', scheduledStart: start, scheduledEnd: end, status: MentorBookingStatus.requested, cancellationReason: null, createdAt: new Date(), updatedAt: new Date(), history: [], mentorProfile: { id: 'mentor-id', headline: 'Mentor', timezone: 'UTC', user: { fullName: 'Mentor', avatarUrl: null } } };
  const participant = { status: MentorBookingStatus.requested, scheduledStart: start, scheduledEnd: end, pendingRequestedById: 'student-id', studentId: 'student-id', mentorProfileId: 'mentor-id', mentorProfile: { userId: 'mentor-user-id', timezone: 'UTC', availability: [{ dayOfWeek: 2, startMinute: 540, endMinute: 600 }] } };
  const prisma: any = {
    mentorProfile: { findFirst: jest.fn() },
    mentorBooking: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { createForUser: jest.fn() };
  let service: MentorBookingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((input: any) => typeof input === 'function' ? input(prisma) : Promise.all(input));
    prisma.mentorProfile.findFirst.mockResolvedValue({ userId: 'mentor-user-id', timezone: 'UTC', availability: participant.mentorProfile.availability });
    prisma.mentorBooking.create.mockResolvedValue(booking);
    prisma.mentorBooking.findFirst.mockResolvedValue(participant);
    prisma.mentorBooking.findUnique.mockResolvedValue({ studentId: 'student-id', mentorProfile: { userId: 'mentor-user-id' } });
    prisma.mentorBooking.update.mockResolvedValue({ ...booking, status: MentorBookingStatus.accepted });
    notifications.createForUser.mockResolvedValue({ id: 'notification-id' });
    service = new MentorBookingsService(prisma, notifications as never);
  });

  it('creates an initial request only within active mentor availability and notifies the mentor', async () => {
    await service.create('student-id', 'mentor-id', { topic: 'Career planning', scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() });
    expect(prisma.mentorBooking.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingRequestedById: 'student-id', scheduledStart: start, scheduledEnd: end, history: { create: expect.objectContaining({ toStatus: MentorBookingStatus.requested }) } }) }));
    expect(notifications.createForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'mentor-user-id', type: 'MENTOR_BOOKING_CHANGED', link: '/instructor/dashboard/mentor-bookings' }));
  });

  it('rejects times outside recurring availability', async () => {
    await expect(service.create('student-id', 'mentor-id', { topic: 'Career planning', scheduledStart: '2030-01-01T08:00:00.000Z', scheduledEnd: '2030-01-01T09:00:00.000Z' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mentorBooking.create).not.toHaveBeenCalled();
  });

  it('prevents the requester accepting their own proposal', async () => {
    await expect(service.accept('student-id', 'booking-id')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mentorBooking.update).not.toHaveBeenCalled();
  });

  it('prevents overlapping accepted bookings inside a serializable transaction', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValueOnce(participant).mockResolvedValueOnce({ id: 'overlap-id' });
    await expect(service.accept('mentor-user-id', 'booking-id')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect(prisma.mentorBooking.update).not.toHaveBeenCalled();
  });

  it('accepts a non-overlapping proposal and records history', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValueOnce(participant).mockResolvedValueOnce(null);
    await service.accept('mentor-user-id', 'booking-id');
    expect(prisma.mentorBooking.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: MentorBookingStatus.accepted, history: { create: expect.objectContaining({ fromStatus: MentorBookingStatus.requested, toStatus: MentorBookingStatus.accepted }) } }) }));
  });

  it('records cancellation reason and reschedule canonical times', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValue({ ...participant, status: MentorBookingStatus.accepted });
    await service.cancel('student-id', 'booking-id', { reason: 'Schedule conflict' });
    expect(prisma.mentorBooking.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ cancellationReason: 'Schedule conflict', history: { create: expect.objectContaining({ reason: 'Schedule conflict' }) } }) }));
    prisma.mentorBooking.update.mockClear();
    await service.reschedule('mentor-user-id', 'booking-id', { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() });
    expect(prisma.mentorBooking.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: MentorBookingStatus.reschedule_requested, pendingRequestedById: 'mentor-user-id', scheduledStart: start, scheduledEnd: end, history: { create: expect.objectContaining({ previousScheduledStart: start, previousScheduledEnd: end }) } }) }));
  });

  it('retries a serializable conflict before accepting', async () => {
    const serialization = new Prisma.PrismaClientKnownRequestError('retry', { code: 'P2034', clientVersion: 'test' });
    prisma.$transaction.mockRejectedValueOnce(serialization).mockImplementationOnce((operation: any) => operation(prisma));
    prisma.mentorBooking.findFirst.mockResolvedValueOnce(participant).mockResolvedValueOnce(null);
    await service.accept('mentor-user-id', 'booking-id');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
