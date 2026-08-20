import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MentorBookingStatus, RoleName } from '../../../generated/prisma/client';
import { MentorOutcomesService } from './mentor-outcomes.service';

describe('MentorOutcomesService', () => {
  const booking = { id: 'booking-id', status: MentorBookingStatus.completed, studentId: 'student-id', mentorProfileId: 'mentor-profile-id', mentorProfile: { userId: 'mentor-id' } };
  const prisma: any = {
    mentorBooking: { findFirst: jest.fn(), update: jest.fn() },
    mentorPrivateNote: { upsert: jest.fn(), findUnique: jest.fn() },
    mentorSharedNote: { upsert: jest.fn(), findUnique: jest.fn() },
    mentorGoal: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    mentorReview: { findUnique: jest.fn(), upsert: jest.fn(), aggregate: jest.fn() },
    mentorSessionAttendance: { count: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: MentorOutcomesService;

  beforeEach(() => {
    jest.clearAllMocks(); prisma.$transaction.mockImplementation((operation: any) => operation(prisma));
    prisma.mentorBooking.findFirst.mockResolvedValue(booking); prisma.mentorGoal.findMany.mockResolvedValue([]);
    prisma.mentorSharedNote.findUnique.mockResolvedValue({ content: 'Shared' }); prisma.mentorPrivateNote.findUnique.mockResolvedValue({ content: 'Private' });
    prisma.mentorReview.findUnique.mockResolvedValue(null); prisma.mentorReview.aggregate.mockResolvedValue({ _avg: { rating: 4.5 }, _count: { rating: 2 } });
    service = new MentorOutcomesService(prisma);
  });

  it('never returns private mentor notes to learners', async () => {
    await expect(service.get({ id: 'student-id', roles: [RoleName.student] }, 'booking-id')).resolves.toEqual(expect.not.objectContaining({ privateNote: expect.anything() }));
    expect(prisma.mentorPrivateNote.findUnique).not.toHaveBeenCalled();
  });

  it('allows only the owning mentor to store a private note', async () => {
    prisma.mentorPrivateNote.upsert.mockResolvedValue({ content: 'Private' });
    await service.savePrivateNote({ id: 'mentor-id', roles: [RoleName.instructor] }, 'booking-id', 'Private');
    await expect(service.savePrivateNote({ id: 'student-id', roles: [RoleName.student] }, 'booking-id', 'No')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('completes only after both booking participants have left the session', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValue({ ...booking, status: MentorBookingStatus.accepted });
    prisma.mentorSessionAttendance.count.mockResolvedValueOnce(1);
    await expect(service.complete({ id: 'mentor-id', roles: [RoleName.instructor] }, 'booking-id')).rejects.toBeInstanceOf(BadRequestException);
    prisma.mentorSessionAttendance.count.mockResolvedValueOnce(2); prisma.mentorBooking.update.mockResolvedValue({ status: MentorBookingStatus.completed });
    await expect(service.complete({ id: 'mentor-id', roles: [RoleName.instructor] }, 'booking-id')).resolves.toEqual({ status: MentorBookingStatus.completed });
  });

  it('requires completion and enforces the seven-day review edit policy', async () => {
    prisma.mentorBooking.findFirst.mockResolvedValueOnce({ ...booking, status: MentorBookingStatus.accepted });
    await expect(service.saveReview('student-id', 'booking-id', { rating: 5, comment: 'Helpful' })).rejects.toBeInstanceOf(BadRequestException);
    prisma.mentorBooking.findFirst.mockResolvedValue(booking);
    prisma.mentorReview.findUnique.mockResolvedValue({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    await expect(service.saveReview('student-id', 'booking-id', { rating: 5, comment: 'Helpful' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates one learner review and reports the mentor aggregate', async () => {
    prisma.mentorReview.findUnique.mockResolvedValue(null);
    prisma.mentorReview.upsert.mockResolvedValue({ rating: 5, comment: 'Helpful' });
    await service.saveReview('student-id', 'booking-id', { rating: 5, comment: 'Helpful' });
    expect(prisma.mentorReview.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { bookingId: 'booking-id' }, create: expect.objectContaining({ studentId: 'student-id', rating: 5 }) }));
    await expect(service.get({ id: 'student-id', roles: [RoleName.student] }, 'booking-id')).resolves.toMatchObject({ rating: { average: 4.5, count: 2 } });
  });
});
