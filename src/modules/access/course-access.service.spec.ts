import { NotFoundException } from '@nestjs/common';
import { CourseAccessSourceType, CourseStatus, CourseVisibility, ModerationStatus, RoleName } from '../../../generated/prisma/client';
import { CourseAccessService } from './course-access.service';

function harness(overrides: Record<string, unknown> = {}) {
  const prisma = {
    course: { findUnique: jest.fn().mockResolvedValue({
      id: 'course-id', instructorId: 'owner-id', deletedAt: null,
      status: CourseStatus.published, visibility: CourseVisibility.public,
      moderationStatus: ModerationStatus.clear,
    }) },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'student-id', deletedAt: null }) },
    courseAccessGrant: {
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'enrollment-id' }),
    },
    lesson: { findMany: jest.fn().mockResolvedValue([{ id: 'lesson-id' }]) },
    learningProgress: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    ...overrides,
  };
  return { service: new CourseAccessService(prisma as never), prisma };
}

const student = { id: 'student-id', roles: [RoleName.student] };

describe('CourseAccessService', () => {
  it('allows owner and administrator management but denies deleted subjects first', async () => {
    const { service, prisma } = harness();
    await expect(service.decide({ user: { id: 'owner-id', roles: [RoleName.instructor] }, courseId: 'course-id', operation: 'MANAGE' }))
      .resolves.toMatchObject({ allowed: true, mode: 'MANAGER' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'owner-id', deletedAt: new Date() });
    await expect(service.decide({ user: { id: 'owner-id', roles: [RoleName.instructor] }, courseId: 'course-id', operation: 'MANAGE' }))
      .resolves.toMatchObject({ allowed: false, reason: 'SUBJECT_NOT_FOUND' });
  });

  it('allows an explicit active grant for a private course', async () => {
    const { service, prisma } = harness();
    prisma.course.findUnique.mockResolvedValueOnce({
      id: 'course-id', instructorId: 'owner-id', deletedAt: null,
      status: CourseStatus.published, visibility: CourseVisibility.private,
      moderationStatus: ModerationStatus.clear,
    });
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce({ id: 'grant-id', endsAt: null, graceEndsAt: null });
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING' }))
      .resolves.toMatchObject({ allowed: true, mode: 'LEARNER' });
  });

  it('allows a bounded grace window but denies after all grant windows close', async () => {
    const { service, prisma } = harness();
    const at = new Date('2026-08-24T12:00:00.000Z');
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce({
      id: 'membership-grant-id',
      endsAt: new Date('2026-08-24T11:00:00.000Z'),
      graceEndsAt: new Date('2026-08-25T11:00:00.000Z'),
    });
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING', at }))
      .resolves.toMatchObject({ allowed: true, mode: 'LEARNER' });
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce(null);
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING', at }))
      .resolves.toMatchObject({ allowed: false, reason: 'COURSE_ACCESS_REQUIRED' });
  });

  it('classifies an explicit membership-grace source as grace rather than active membership access', async () => {
    const { service, prisma } = harness();
    const at = new Date('2026-08-24T12:00:00.000Z');
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce({
      id: 'membership-grace-id',
      sourceType: CourseAccessSourceType.membership_grace,
      endsAt: new Date('2026-08-25T12:00:00.000Z'),
      graceEndsAt: null,
    });
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING', at }))
      .resolves.toMatchObject({ allowed: true, mode: 'LEARNER' });
  });

  it('does not treat compatibility enrollment rows as runtime authorization', async () => {
    const { service, prisma } = harness();
    prisma.enrollment.findFirst.mockResolvedValueOnce({ id: 'enrollment-id', status: 'completed' });
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING' }))
      .resolves.toMatchObject({ allowed: false, reason: 'COURSE_ACCESS_REQUIRED' });
    expect(prisma.enrollment.findFirst).not.toHaveBeenCalled();
  });

  it('allows a deterministic legacy-enrollment backfill grant', async () => {
    const { service, prisma } = harness();
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce({
      id: 'legacy-grant-id', endsAt: null, graceEndsAt: null,
    });
    await expect(service.decide({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING' }))
      .resolves.toMatchObject({ allowed: true, mode: 'LEARNER' });
  });

  it('hides moderated courses despite an active learner grant', async () => {
    const { service, prisma } = harness();
    prisma.course.findUnique.mockResolvedValueOnce({
      id: 'course-id', instructorId: 'owner-id', deletedAt: null,
      status: CourseStatus.published, visibility: CourseVisibility.public,
      moderationStatus: ModerationStatus.hidden,
    });
    prisma.courseAccessGrant.findFirst.mockResolvedValueOnce({ id: 'grant-id' });
    await expect(service.require({ user: student, courseId: 'course-id', operation: 'FULL_LEARNING' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows only a marked resource through public preview', async () => {
    const { service } = harness();
    await expect(service.decide({ courseId: 'course-id', operation: 'PUBLIC_PREVIEW', isPreviewResource: true }))
      .resolves.toMatchObject({ allowed: true, mode: 'PREVIEW' });
    await expect(service.decide({ courseId: 'course-id', operation: 'PUBLIC_PREVIEW', isPreviewResource: false }))
      .resolves.toMatchObject({ allowed: false });
  });

  it('creates an idempotent additive grant and preserves compatible learning records', async () => {
    const { service, prisma } = harness();
    await service.ensureGrant({
      userId: 'student-id', courseId: 'course-id', sourceType: 'free_enrollment',
      sourceId: 'enrollment-id', startsAt: new Date('2026-08-24T00:00:00.000Z'),
    });
    expect(prisma.courseAccessGrant.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(prisma.enrollment.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(prisma.learningProgress.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('revokes only the exact source grant and rejects an empty reason', async () => {
    const { service, prisma } = harness();
    prisma.courseAccessGrant.findUnique.mockResolvedValue({ id: 'grant-id', status: 'active' });
    prisma.courseAccessGrant.update.mockResolvedValue({ id: 'grant-id', status: 'revoked' });
    await expect(service.revokeGrant({
      userId: 'student-id', courseId: 'course-id', sourceType: 'tmi_reward', sourceId: 'redemption-id',
    }, 'TMI_REWARD_REFUNDED')).resolves.toMatchObject({ status: 'revoked' });
    expect(prisma.courseAccessGrant.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'grant-id' },
      data: expect.objectContaining({ revocationReason: 'TMI_REWARD_REFUNDED' }),
    }));
    await expect(service.revokeGrant({
      userId: 'student-id', courseId: 'course-id', sourceType: 'tmi_reward', sourceId: 'redemption-id',
    }, ' ')).rejects.toThrow('Invalid course access revocation reason');
  });
});
