import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MentorApprovalStatus, MentorBookingStatus, NotificationCategory, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateMentorBookingDto, ListMentorBookingsQueryDto, MentorBookingReasonDto, RescheduleMentorBookingDto } from './dto/mentor-booking.dto';

const historySelect = { fromStatus: true, toStatus: true, previousScheduledStart: true, previousScheduledEnd: true, scheduledStart: true, scheduledEnd: true, reason: true, createdAt: true } satisfies Prisma.MentorBookingStatusHistorySelect;
const baseSelect = { id: true, topic: true, scheduledStart: true, scheduledEnd: true, status: true, cancellationReason: true, createdAt: true, updatedAt: true, history: { select: historySelect, orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.MentorBookingSelect;
const studentSelect = { ...baseSelect, mentorProfile: { select: { id: true, headline: true, timezone: true, user: { select: { fullName: true, avatarUrl: true } } } } } satisfies Prisma.MentorBookingSelect;
const mentorSelect = { ...baseSelect, student: { select: { fullName: true, avatarUrl: true } } } satisfies Prisma.MentorBookingSelect;
const participantSelect = { status: true, scheduledStart: true, scheduledEnd: true, pendingRequestedById: true, studentId: true, mentorProfileId: true, mentorProfile: { select: { userId: true, timezone: true, availability: { select: { dayOfWeek: true, startMinute: true, endMinute: true } } } } } satisfies Prisma.MentorBookingSelect;
const proposalStatuses = new Set<MentorBookingStatus>([MentorBookingStatus.requested, MentorBookingStatus.reschedule_requested]);
const cancellableStatuses = new Set<MentorBookingStatus>([MentorBookingStatus.requested, MentorBookingStatus.accepted, MentorBookingStatus.reschedule_requested]);
type StudentBooking = Prisma.MentorBookingGetPayload<{ select: typeof studentSelect }>;
type MentorBooking = Prisma.MentorBookingGetPayload<{ select: typeof mentorSelect }>;
export interface BookingPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

@Injectable()
export class MentorBookingsService {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  async create(studentId: string, mentorProfileId: string, input: CreateMentorBookingDto): Promise<StudentBooking> {
    const start = new Date(input.scheduledStart); const end = new Date(input.scheduledEnd); this.assertTime(start, end);
    const mentor = await this.prisma.mentorProfile.findFirst({ where: { id: mentorProfileId, status: MentorApprovalStatus.approved, isActive: true }, select: { userId: true, timezone: true, availability: { select: { dayOfWeek: true, startMinute: true, endMinute: true } } } });
    if (!mentor) throw new NotFoundException('Mentor not found');
    this.assertAvailable(start, end, mentor.timezone, mentor.availability);
    const booking = await this.prisma.mentorBooking.create({ data: { mentorProfileId, studentId, topic: input.topic, scheduledStart: start, scheduledEnd: end, pendingRequestedById: studentId, history: { create: { fromStatus: null, toStatus: MentorBookingStatus.requested, changedById: studentId, scheduledStart: start, scheduledEnd: end } } }, select: studentSelect });
    await this.notify(mentor.userId, booking.id, 'Yêu cầu cố vấn mới', 'Một học viên đã gửi yêu cầu đặt lịch cố vấn.', '/instructor/dashboard/mentor-bookings');
    return booking;
  }

  listStudent(studentId: string, query: ListMentorBookingsQueryDto): Promise<BookingPage<StudentBooking>> { return this.page({ studentId }, query, studentSelect); }
  listMentor(mentorUserId: string, query: ListMentorBookingsQueryDto): Promise<BookingPage<MentorBooking>> { return this.page({ mentorProfile: { userId: mentorUserId } }, query, mentorSelect); }

  accept(actorId: string, id: string) {
    return this.runSerializable(async (tx) => {
      const current = await this.findParticipant(tx, actorId, id);
      if (!proposalStatuses.has(current.status)) throw new BadRequestException('Booking cannot be accepted from its current status');
      if (current.pendingRequestedById === actorId) throw new BadRequestException('The requester cannot accept their own proposal');
      await this.assertNoAcceptedOverlap(tx, id, current.mentorProfileId, current.studentId, current.scheduledStart, current.scheduledEnd);
      return tx.mentorBooking.update({ where: { id }, data: { status: MentorBookingStatus.accepted, history: { create: { fromStatus: current.status, toStatus: MentorBookingStatus.accepted, changedById: actorId, scheduledStart: current.scheduledStart, scheduledEnd: current.scheduledEnd } } }, select: actorId === current.studentId ? studentSelect : mentorSelect });
    }).then(async (booking) => { await this.notifyOther(actorId, id, 'Lịch cố vấn đã được chấp nhận', 'Đề xuất thời gian cố vấn đã được chấp nhận.'); return booking; });
  }

  reject(actorId: string, id: string, input: MentorBookingReasonDto) {
    return this.transitionProposal(actorId, id, MentorBookingStatus.rejected, input.reason);
  }

  cancel(actorId: string, id: string, input: MentorBookingReasonDto) {
    return this.runSerializable(async (tx) => {
      const current = await this.findParticipant(tx, actorId, id);
      if (!cancellableStatuses.has(current.status)) throw new BadRequestException('Booking cannot be cancelled from its current status');
      return tx.mentorBooking.update({ where: { id }, data: { status: MentorBookingStatus.cancelled, cancellationReason: input.reason, history: { create: { fromStatus: current.status, toStatus: MentorBookingStatus.cancelled, changedById: actorId, scheduledStart: current.scheduledStart, scheduledEnd: current.scheduledEnd, reason: input.reason } } }, select: actorId === current.studentId ? studentSelect : mentorSelect });
    }).then(async (booking) => { await this.notifyOther(actorId, id, 'Lịch cố vấn đã hủy', 'Một bên tham gia đã hủy lịch cố vấn.'); return booking; });
  }

  reschedule(actorId: string, id: string, input: RescheduleMentorBookingDto) {
    const start = new Date(input.scheduledStart); const end = new Date(input.scheduledEnd); this.assertTime(start, end);
    return this.runSerializable(async (tx) => {
      const current = await this.findParticipant(tx, actorId, id);
      if (current.status !== MentorBookingStatus.accepted) throw new BadRequestException('Only accepted bookings can be rescheduled');
      this.assertAvailable(start, end, current.mentorProfile.timezone, current.mentorProfile.availability);
      return tx.mentorBooking.update({ where: { id }, data: { status: MentorBookingStatus.reschedule_requested, scheduledStart: start, scheduledEnd: end, pendingRequestedById: actorId, history: { create: { fromStatus: current.status, toStatus: MentorBookingStatus.reschedule_requested, changedById: actorId, previousScheduledStart: current.scheduledStart, previousScheduledEnd: current.scheduledEnd, scheduledStart: start, scheduledEnd: end } } }, select: actorId === current.studentId ? studentSelect : mentorSelect });
    }).then(async (booking) => { await this.notifyOther(actorId, id, 'Đề xuất đổi lịch cố vấn', 'Một bên tham gia đã đề xuất thời gian cố vấn mới.'); return booking; });
  }

  private transitionProposal(actorId: string, id: string, status: MentorBookingStatus, reason: string) {
    return this.runSerializable(async (tx) => {
      const current = await this.findParticipant(tx, actorId, id);
      if (!proposalStatuses.has(current.status)) throw new BadRequestException('Booking proposal cannot be rejected from its current status');
      if (current.pendingRequestedById === actorId) throw new BadRequestException('The requester cannot reject their own proposal');
      return tx.mentorBooking.update({ where: { id }, data: { status, history: { create: { fromStatus: current.status, toStatus: status, changedById: actorId, scheduledStart: current.scheduledStart, scheduledEnd: current.scheduledEnd, reason } } }, select: actorId === current.studentId ? studentSelect : mentorSelect });
    }).then(async (booking) => { await this.notifyOther(actorId, id, 'Yêu cầu cố vấn bị từ chối', 'Đề xuất lịch cố vấn đã bị từ chối.'); return booking; });
  }

  private async findParticipant(tx: Prisma.TransactionClient, actorId: string, id: string) {
    const booking = await tx.mentorBooking.findFirst({ where: { id, OR: [{ studentId: actorId }, { mentorProfile: { userId: actorId } }] }, select: participantSelect });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  private async assertNoAcceptedOverlap(tx: Prisma.TransactionClient, id: string, mentorProfileId: string, studentId: string, start: Date, end: Date): Promise<void> {
    const overlap = await tx.mentorBooking.findFirst({ where: { id: { not: id }, status: MentorBookingStatus.accepted, scheduledStart: { lt: end }, scheduledEnd: { gt: start }, OR: [{ mentorProfileId }, { studentId }] }, select: { id: true } });
    if (overlap) throw new ConflictException('The accepted booking overlaps another confirmed appointment');
  }

  private assertTime(start: Date, end: Date): void {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new BadRequestException('Booking end must be after start');
    if (start <= new Date()) throw new BadRequestException('Booking must be scheduled in the future');
    const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
    if (durationMinutes < 15 || durationMinutes > 240) throw new BadRequestException('Booking duration must be between 15 and 240 minutes');
  }

  private assertAvailable(start: Date, end: Date, timezone: string, slots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>): void {
    const startLocal = this.localParts(start, timezone); const endLocal = this.localParts(end, timezone);
    const fits = startLocal.dayOfWeek === endLocal.dayOfWeek && slots.some((slot) => slot.dayOfWeek === startLocal.dayOfWeek && startLocal.minute >= slot.startMinute && endLocal.minute <= slot.endMinute);
    if (!fits) throw new BadRequestException('Requested time is outside mentor availability');
  }

  private localParts(date: Date, timezone: string): { dayOfWeek: number; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday), minute: Number(value.hour) * 60 + Number(value.minute) };
  }

  private async page<TSelect extends Prisma.MentorBookingSelect, TRecord = Prisma.MentorBookingGetPayload<{ select: TSelect }>>(where: Prisma.MentorBookingWhereInput, query: ListMentorBookingsQueryDto, select: TSelect): Promise<BookingPage<TRecord>> {
    const [total, items] = await this.prisma.$transaction([this.prisma.mentorBooking.count({ where }), this.prisma.mentorBooking.findMany({ where, select, orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items: items as TRecord[], page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  private async notifyOther(actorId: string, bookingId: string, title: string, body: string): Promise<void> {
    const booking = await this.prisma.mentorBooking.findUnique({ where: { id: bookingId }, select: { studentId: true, mentorProfile: { select: { userId: true } } } });
    if (!booking) return;
    const recipientIsMentor = actorId === booking.studentId;
    await this.notify(recipientIsMentor ? booking.mentorProfile.userId : booking.studentId, bookingId, title, body, recipientIsMentor ? '/instructor/dashboard/mentor-bookings' : '/dashboard/mentor-bookings');
  }

  private async notify(userId: string, bookingId: string, title: string, body: string, link: string): Promise<void> {
    try { await this.notifications.createForUser({ userId, eventKey: `mentor-booking:${bookingId}:${title}`, type: 'MENTOR_BOOKING_CHANGED', category: NotificationCategory.system, title, body, link }); } catch { /* Booking state remains authoritative. */ }
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) throw error; }
    }
    throw new ConflictException('Booking changed concurrently');
  }
}
