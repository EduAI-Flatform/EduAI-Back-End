import { BadRequestException, ConflictException } from '@nestjs/common';
import { MentorApprovalStatus } from '../../../generated/prisma/client';
import { MentorsService } from './mentors.service';

describe('MentorsService', () => {
  const owner = { id: 'mentor-id', headline: 'Backend mentor', bio: null, timezone: 'Asia/Ho_Chi_Minh', status: MentorApprovalStatus.pending, isActive: false, approvedAt: null, expertise: [{ name: 'NestJS' }], availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }] };
  const prisma: any = {
    mentorProfile: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    mentorExpertise: { deleteMany: jest.fn(), createMany: jest.fn() },
    mentorAvailability: { deleteMany: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn() };
  let service: MentorsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((input: any) => typeof input === 'function' ? input(prisma) : Promise.all(input));
    service = new MentorsService(prisma, audit as never);
  });

  it('stores recurring local-minute availability with an explicit IANA timezone', async () => {
    prisma.mentorProfile.findUnique.mockResolvedValue(null);
    prisma.mentorProfile.create.mockResolvedValue({ id: 'mentor-id' });
    prisma.mentorProfile.findUniqueOrThrow.mockResolvedValue(owner);

    await expect(service.updateMine('instructor-id', { headline: 'Backend mentor', bio: null, timezone: 'Asia/Ho_Chi_Minh', expertise: ['NestJS', 'nestjs'], availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }] })).resolves.toEqual(owner);
    expect(prisma.mentorExpertise.createMany).toHaveBeenCalledWith({ data: [{ mentorProfileId: 'mentor-id', name: 'NestJS' }] });
    expect(prisma.mentorAvailability.createMany).toHaveBeenCalledWith({ data: [{ mentorProfileId: 'mentor-id', dayOfWeek: 1, startMinute: 540, endMinute: 600 }] });
  });

  it('rejects invalid timezones and overlapping recurring slots', async () => {
    await expect(service.updateMine('instructor-id', { headline: 'Mentor', timezone: 'not/a-zone', expertise: [], availability: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateMine('instructor-id', { headline: 'Mentor', timezone: 'UTC', expertise: [], availability: [{ dayOfWeek: 2, startMinute: 500, endMinute: 600 }, { dayOfWeek: 2, startMinute: 550, endMinute: 650 }] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows activation only after approval and with availability', async () => {
    prisma.mentorProfile.findUnique.mockResolvedValue({ id: 'mentor-id', status: MentorApprovalStatus.pending, availability: [{ id: 'slot' }] });
    await expect(service.setActive('instructor-id', true)).rejects.toBeInstanceOf(ConflictException);
    prisma.mentorProfile.findUnique.mockResolvedValue({ id: 'mentor-id', status: MentorApprovalStatus.approved, availability: [{ id: 'slot' }] });
    prisma.mentorProfile.update.mockResolvedValue({ ...owner, status: MentorApprovalStatus.approved, isActive: true });
    await expect(service.setActive('instructor-id', true)).resolves.toMatchObject({ isActive: true });
  });

  it('returns only approved active mentors with paginated filters and no contact projection', async () => {
    prisma.mentorProfile.count.mockResolvedValue(1);
    prisma.mentorProfile.findMany.mockResolvedValue([{ id: 'mentor-id', user: { fullName: 'Instructor', avatarUrl: null }, headline: 'Backend mentor', bio: null, timezone: 'UTC', isActive: true, expertise: [], availability: [] }]);
    const page = await service.listDirectory({ page: 2, pageSize: 10, search: 'backend', expertise: 'NestJS', timezone: 'UTC' });
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    const find = prisma.mentorProfile.findMany.mock.calls[0][0];
    expect(find.where).toMatchObject({ status: MentorApprovalStatus.approved, isActive: true, timezone: 'UTC' });
    expect(find.where.user.roles.some.role.name).toBe('instructor');
    expect(find.select.user.select).toEqual({ fullName: true, avatarUrl: true });
    expect(find.select.user.select).not.toHaveProperty('email');
  });

  it('audits administrator approval and deactivates rejection atomically', async () => {
    prisma.mentorProfile.findUnique.mockResolvedValue({ status: MentorApprovalStatus.pending, user: { status: 'active', deletedAt: null, roles: [{ role: { name: 'instructor' } }] } });
    prisma.mentorProfile.update.mockResolvedValue({ ...owner, status: MentorApprovalStatus.rejected });
    await service.setApproval('admin-id', 'mentor-id', { status: MentorApprovalStatus.rejected });
    expect(prisma.mentorProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false, status: MentorApprovalStatus.rejected }) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-id', metadata: { previousStatus: MentorApprovalStatus.pending, newStatus: MentorApprovalStatus.rejected } }), prisma);
  });

  it('rejects approval when the profile owner is no longer an active instructor', async () => {
    prisma.mentorProfile.findUnique.mockResolvedValue({ status: MentorApprovalStatus.pending, user: { status: 'active', deletedAt: null, roles: [{ role: { name: 'student' } }] } });
    await expect(service.setApproval('admin-id', 'mentor-id', { status: MentorApprovalStatus.approved })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.mentorProfile.update).not.toHaveBeenCalled();
  });
});
