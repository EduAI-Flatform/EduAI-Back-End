import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MentorBookingStatus, MentorGoalStatus, Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MentorReviewDto } from './dto/mentor-outcome.dto';

const noteSelect = { content: true, updatedAt: true } satisfies Prisma.MentorSharedNoteSelect;
const goalSelect = { id: true, content: true, status: true, createdAt: true, updatedAt: true } satisfies Prisma.MentorGoalSelect;
const reviewSelect = { rating: true, comment: true, createdAt: true, updatedAt: true } satisfies Prisma.MentorReviewSelect;
const EDIT_WINDOW_MS = 7 * 86_400_000;

@Injectable()
export class MentorOutcomesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser, bookingId: string) {
    const booking = await this.findParticipant(this.prisma, user.id, bookingId);
    const [sharedNote, goals, review, rating] = await Promise.all([
      this.prisma.mentorSharedNote.findUnique({ where: { bookingId }, select: noteSelect }),
      this.prisma.mentorGoal.findMany({ where: { bookingId }, select: goalSelect, orderBy: { createdAt: 'asc' } }),
      this.prisma.mentorReview.findUnique({ where: { bookingId }, select: reviewSelect }),
      this.prisma.mentorReview.aggregate({ where: { booking: { mentorProfileId: booking.mentorProfileId } }, _avg: { rating: true }, _count: { rating: true } }),
    ]);
    const common = { sharedNote, goals, review, rating: { average: rating._avg.rating === null ? null : Math.round(rating._avg.rating * 10) / 10, count: rating._count.rating } };
    if (booking.mentorProfile.userId !== user.id) return common;
    const privateNote = await this.prisma.mentorPrivateNote.findUnique({ where: { bookingId }, select: noteSelect });
    return { ...common, privateNote };
  }

  async savePrivateNote(user: AuthenticatedUser, bookingId: string, content: string) {
    const booking = await this.findParticipant(this.prisma, user.id, bookingId);
    if (booking.mentorProfile.userId !== user.id || !user.roles.includes(RoleName.instructor)) throw new ForbiddenException('Only the booking mentor can write private notes');
    this.assertOutcomeWritable(booking.status);
    return this.prisma.mentorPrivateNote.upsert({ where: { bookingId }, create: { bookingId, content }, update: { content }, select: noteSelect });
  }

  async saveSharedNote(user: AuthenticatedUser, bookingId: string, content: string) {
    const booking = await this.findParticipant(this.prisma, user.id, bookingId);
    if (booking.mentorProfile.userId !== user.id || !user.roles.includes(RoleName.instructor)) throw new ForbiddenException('Only the booking mentor can write shared notes');
    this.assertOutcomeWritable(booking.status);
    return this.prisma.mentorSharedNote.upsert({ where: { bookingId }, create: { bookingId, content }, update: { content }, select: noteSelect });
  }

  async createGoal(user: AuthenticatedUser, bookingId: string, content: string) {
    const booking = await this.findParticipant(this.prisma, user.id, bookingId);
    if (booking.mentorProfile.userId !== user.id || !user.roles.includes(RoleName.instructor)) throw new ForbiddenException('Only the booking mentor can create goals');
    this.assertOutcomeWritable(booking.status);
    return this.prisma.mentorGoal.create({ data: { bookingId, createdById: user.id, content }, select: goalSelect });
  }

  async updateGoal(user: AuthenticatedUser, bookingId: string, goalId: string, status: MentorGoalStatus) {
    await this.findParticipant(this.prisma, user.id, bookingId);
    const goal = await this.prisma.mentorGoal.findFirst({ where: { id: goalId, bookingId }, select: { id: true } });
    if (!goal) throw new NotFoundException('Mentor goal not found');
    return this.prisma.mentorGoal.update({ where: { id: goalId }, data: { status }, select: goalSelect });
  }

  async complete(user: AuthenticatedUser, bookingId: string) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await this.findParticipant(tx, user.id, bookingId);
      if (booking.mentorProfile.userId !== user.id || !user.roles.includes(RoleName.instructor)) throw new ForbiddenException('Only the booking mentor can complete the session');
      if (booking.status !== MentorBookingStatus.accepted) throw new BadRequestException('Only accepted bookings can be completed');
      const endedParticipants = await tx.mentorSessionAttendance.count({ where: { session: { bookingId }, userId: { in: [booking.studentId, booking.mentorProfile.userId] }, leftAt: { not: null } } });
      if (endedParticipants !== 2) throw new BadRequestException('Both participants must join and leave before completion');
      return tx.mentorBooking.update({ where: { id: bookingId }, data: { status: MentorBookingStatus.completed, history: { create: { fromStatus: booking.status, toStatus: MentorBookingStatus.completed, changedById: user.id, scheduledStart: booking.scheduledStart, scheduledEnd: booking.scheduledEnd } } }, select: { status: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async saveReview(studentId: string, bookingId: string, input: MentorReviewDto) {
    const booking = await this.findParticipant(this.prisma, studentId, bookingId);
    if (booking.studentId !== studentId) throw new ForbiddenException('Only the booking learner can review');
    if (booking.status !== MentorBookingStatus.completed) throw new BadRequestException('Only completed bookings can be reviewed');
    const existing = await this.prisma.mentorReview.findUnique({ where: { bookingId }, select: { createdAt: true } });
    if (existing && Date.now() - existing.createdAt.getTime() >= EDIT_WINDOW_MS) throw new BadRequestException('Reviews can be edited for seven days after creation');
    return this.prisma.mentorReview.upsert({ where: { bookingId }, create: { bookingId, studentId, rating: input.rating, comment: input.comment }, update: { rating: input.rating, comment: input.comment }, select: reviewSelect });
  }

  private async findParticipant(tx: Prisma.TransactionClient | PrismaService, actorId: string, bookingId: string) {
    const booking = await tx.mentorBooking.findFirst({ where: { id: bookingId, OR: [{ studentId: actorId }, { mentorProfile: { userId: actorId } }] }, select: { id: true, status: true, studentId: true, mentorProfileId: true, scheduledStart: true, scheduledEnd: true, mentorProfile: { select: { userId: true } } } });
    if (!booking) throw new NotFoundException('Mentor booking not found');
    return booking;
  }

  private assertOutcomeWritable(status: MentorBookingStatus): void {
    if (status !== MentorBookingStatus.accepted && status !== MentorBookingStatus.completed) throw new BadRequestException('Mentor outcomes require an accepted or completed booking');
  }
}
