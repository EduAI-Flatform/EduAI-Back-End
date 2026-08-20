import { Injectable, NotFoundException } from '@nestjs/common';
import { MentorBookingStatus, Prisma, RoleName } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { JitsiRoomService } from '../classrooms/jitsi-room.service';

const attendanceSelect = { joinedAt: true, leftAt: true, durationSeconds: true } satisfies Prisma.MentorSessionAttendanceSelect;
export type MentorSessionAttendanceResponse = Prisma.MentorSessionAttendanceGetPayload<{ select: typeof attendanceSelect }>;
export interface JoinedMentorSessionResponse { meetingUrl: string; joinedAt: Date; leftAt: Date | null }

@Injectable()
export class MentorSessionsService {
  constructor(private readonly prisma: PrismaService, private readonly rooms: JitsiRoomService) {}

  async join(user: AuthenticatedUser, bookingId: string): Promise<JoinedMentorSessionResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const booking = await this.findBooking(tx, user, bookingId, true);
      const roomName = this.rooms.generateRoomName(booking.id, booking.topic);
      const session = await tx.mentorSession.upsert({
        where: { bookingId },
        create: { bookingId, roomName },
        update: {},
        select: { id: true, roomName: true },
      });
      const attendance = await tx.mentorSessionAttendance.upsert({
        where: { sessionId_userId: { sessionId: session.id, userId: user.id } },
        create: { sessionId: session.id, userId: user.id },
        update: {},
        select: attendanceSelect,
      });
      return { roomName: session.roomName, attendance };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { meetingUrl: this.rooms.buildMeetingUrl(result.roomName), joinedAt: result.attendance.joinedAt, leftAt: result.attendance.leftAt };
  }

  async leave(user: AuthenticatedUser, bookingId: string): Promise<MentorSessionAttendanceResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.findBooking(tx, user, bookingId, false);
      const session = await tx.mentorSession.findUnique({ where: { bookingId }, select: { id: true } });
      if (!session) throw new NotFoundException('Mentor session not found');
      const key = { sessionId_userId: { sessionId: session.id, userId: user.id } };
      const attendance = await tx.mentorSessionAttendance.findUnique({ where: key, select: attendanceSelect });
      if (!attendance) throw new NotFoundException('Mentor session attendance not found');
      const now = new Date();
      const durationSeconds = Math.max(0, Math.floor((now.getTime() - attendance.joinedAt.getTime()) / 1000));
      await tx.mentorSessionAttendance.updateMany({
        where: { sessionId: session.id, userId: user.id, leftAt: null },
        data: { leftAt: now, durationSeconds },
      });
      return tx.mentorSessionAttendance.findUniqueOrThrow({ where: key, select: attendanceSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async findBooking(tx: Prisma.TransactionClient, user: AuthenticatedUser, bookingId: string, acceptedOnly: boolean) {
    const isAdmin = user.roles.includes(RoleName.platform_admin);
    const participant = { OR: [{ studentId: user.id }, { mentorProfile: { userId: user.id } }] };
    const booking = await tx.mentorBooking.findFirst({
      where: { id: bookingId, ...(acceptedOnly ? { status: MentorBookingStatus.accepted } : {}), ...(isAdmin ? {} : participant) },
      select: { id: true, topic: true },
    });
    if (!booking) throw new NotFoundException('Mentor booking not found');
    return booking;
  }
}
