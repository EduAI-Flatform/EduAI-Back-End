import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MentorApprovalStatus, Prisma, RoleName, UserStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ListMentorsQueryDto, MentorAvailabilityDto, SetMentorApprovalDto, UpdateMentorProfileDto } from './dto/mentor.dto';

const expertiseSelect = { name: true } satisfies Prisma.MentorExpertiseSelect;
const availabilitySelect = { dayOfWeek: true, startMinute: true, endMinute: true } satisfies Prisma.MentorAvailabilitySelect;
const ownerSelect = { id: true, headline: true, bio: true, timezone: true, status: true, isActive: true, approvedAt: true, expertise: { select: expertiseSelect, orderBy: { name: 'asc' as const } }, availability: { select: availabilitySelect, orderBy: [{ dayOfWeek: 'asc' as const }, { startMinute: 'asc' as const }] } } satisfies Prisma.MentorProfileSelect;
const directorySelect = { ...ownerSelect, status: false, approvedAt: false, user: { select: { fullName: true, avatarUrl: true } } } satisfies Prisma.MentorProfileSelect;
const adminSelect = { ...ownerSelect, user: { select: { fullName: true, avatarUrl: true } } } satisfies Prisma.MentorProfileSelect;
type OwnerResponse = Prisma.MentorProfileGetPayload<{ select: typeof ownerSelect }>;
type DirectoryRecord = Prisma.MentorProfileGetPayload<{ select: typeof directorySelect }>;
export interface MentorDirectoryPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

@Injectable()
export class MentorsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  getMine(userId: string): Promise<OwnerResponse | null> {
    return this.prisma.mentorProfile.findUnique({ where: { userId }, select: ownerSelect });
  }

  async updateMine(userId: string, input: UpdateMentorProfileDto): Promise<OwnerResponse> {
    this.assertTimezone(input.timezone);
    this.assertAvailability(input.availability);
    const expertise = this.normalizeExpertise(input.expertise);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.mentorProfile.findUnique({ where: { userId }, select: { id: true, status: true } });
      const profile = current
        ? await tx.mentorProfile.update({ where: { id: current.id }, data: { headline: input.headline, bio: input.bio, timezone: input.timezone, ...(input.availability.length === 0 ? { isActive: false } : {}), ...(current.status === MentorApprovalStatus.rejected ? { status: MentorApprovalStatus.pending, isActive: false } : {}) }, select: { id: true } })
        : await tx.mentorProfile.create({ data: { userId, headline: input.headline, bio: input.bio, timezone: input.timezone }, select: { id: true } });
      await tx.mentorExpertise.deleteMany({ where: { mentorProfileId: profile.id } });
      await tx.mentorAvailability.deleteMany({ where: { mentorProfileId: profile.id } });
      if (expertise.length) await tx.mentorExpertise.createMany({ data: expertise.map((name) => ({ mentorProfileId: profile.id, name })) });
      if (input.availability.length) await tx.mentorAvailability.createMany({ data: input.availability.map((slot) => ({ mentorProfileId: profile.id, ...slot })) });
      return tx.mentorProfile.findUniqueOrThrow({ where: { id: profile.id }, select: ownerSelect });
    });
  }

  async setActive(userId: string, isActive: boolean): Promise<OwnerResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.mentorProfile.findUnique({ where: { userId }, select: { id: true, status: true, availability: { select: { id: true }, take: 1 } } });
      if (!current) throw new NotFoundException('Mentor profile not found');
      if (isActive && current.status !== MentorApprovalStatus.approved) throw new ConflictException('Mentor approval is required before activation');
      if (isActive && !current.availability.length) throw new BadRequestException('At least one availability slot is required before activation');
      return tx.mentorProfile.update({ where: { id: current.id }, data: { isActive }, select: ownerSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listDirectory(query: ListMentorsQueryDto): Promise<MentorDirectoryPage<DirectoryRecord>> {
    const where: Prisma.MentorProfileWhereInput = { status: MentorApprovalStatus.approved, isActive: true, user: { status: UserStatus.active, deletedAt: null, roles: { some: { role: { name: RoleName.instructor } } } }, ...this.filters(query) };
    return this.page(where, query, directorySelect);
  }

  async getDirectory(id: string): Promise<DirectoryRecord> {
    const mentor = await this.prisma.mentorProfile.findFirst({ where: { id, status: MentorApprovalStatus.approved, isActive: true, user: { status: UserStatus.active, deletedAt: null, roles: { some: { role: { name: RoleName.instructor } } } } }, select: directorySelect });
    if (!mentor) throw new NotFoundException('Mentor not found');
    return mentor;
  }

  listAdmin(query: ListMentorsQueryDto) {
    const where: Prisma.MentorProfileWhereInput = { ...(query.status ? { status: query.status } : {}), ...this.filters(query) };
    return this.page(where, query, adminSelect);
  }

  async setApproval(actorId: string, id: string, input: SetMentorApprovalDto): Promise<OwnerResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.mentorProfile.findUnique({ where: { id }, select: { status: true, user: { select: { status: true, deletedAt: true, roles: { select: { role: { select: { name: true } } } } } } } });
      if (!current) throw new NotFoundException('Mentor profile not found');
      if (input.status === MentorApprovalStatus.approved && (current.user.status !== UserStatus.active || current.user.deletedAt || !current.user.roles.some(({ role }) => role.name === RoleName.instructor))) throw new ConflictException('Only active instructors can be approved as mentors');
      const updated = await tx.mentorProfile.update({ where: { id }, data: { status: input.status, approvedById: actorId, approvedAt: input.status === MentorApprovalStatus.approved ? new Date() : null, ...(input.status === MentorApprovalStatus.rejected ? { isActive: false } : {}) }, select: ownerSelect });
      await this.audit.record({ actorId, action: AuditAction.MentorApprovalChanged, target: { type: 'mentor_profile', id }, metadata: { previousStatus: current.status, newStatus: input.status } }, tx);
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private filters(query: Pick<ListMentorsQueryDto, 'search' | 'expertise' | 'timezone'>): Prisma.MentorProfileWhereInput {
    return {
      ...(query.search ? { OR: [{ headline: { contains: query.search, mode: 'insensitive' } }, { bio: { contains: query.search, mode: 'insensitive' } }, { user: { fullName: { contains: query.search, mode: 'insensitive' } } }, { expertise: { some: { name: { contains: query.search, mode: 'insensitive' } } } }] } : {}),
      ...(query.expertise ? { expertise: { some: { name: { contains: query.expertise, mode: 'insensitive' } } } } : {}),
      ...(query.timezone ? { timezone: query.timezone } : {}),
    };
  }

  private async page<TSelect extends Prisma.MentorProfileSelect, TRecord = Prisma.MentorProfileGetPayload<{ select: TSelect }>>(where: Prisma.MentorProfileWhereInput, query: ListMentorsQueryDto, select: TSelect): Promise<MentorDirectoryPage<TRecord>> {
    const [total, items] = await this.prisma.$transaction([this.prisma.mentorProfile.count({ where }), this.prisma.mentorProfile.findMany({ where, select, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { items: items as TRecord[], page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  private normalizeExpertise(values: string[]): string[] {
    const seen = new Set<string>();
    return values.map((value) => value.trim()).filter((value) => { const key = value.toLocaleLowerCase('en-US'); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  }

  private assertTimezone(timezone: string): void {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new BadRequestException('Timezone must be a valid IANA timezone'); }
  }

  private assertAvailability(slots: MentorAvailabilityDto[]): void {
    const ordered = [...slots].sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    for (let index = 0; index < ordered.length; index += 1) {
      const slot = ordered[index];
      if (slot.startMinute >= slot.endMinute) throw new BadRequestException('Availability start must be before end');
      const previous = ordered[index - 1];
      if (previous && previous.dayOfWeek === slot.dayOfWeek && previous.endMinute > slot.startMinute) throw new BadRequestException('Availability slots cannot overlap');
    }
  }
}
