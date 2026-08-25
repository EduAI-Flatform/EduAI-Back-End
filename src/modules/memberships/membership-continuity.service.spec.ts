import {
  CourseAccessGrantStatus,
  CourseAccessSourceType,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { MembershipContinuityService } from './membership-continuity.service';

const learnerId = '10000000-0000-4000-8000-000000000001';
const courseId = '20000000-0000-4000-8000-000000000001';
const secondCourseId = '30000000-0000-4000-8000-000000000001';
const at = new Date('2028-01-01T00:00:00.000Z');
const termEndsAt = new Date('2028-02-01T00:00:00.000Z');

function version(id: string, courses: Array<{ id: string; graceDays: number }>) {
  return {
    id,
    includedCourses: courses.map((item) => ({
      courseId: item.id,
      graceDays: item.graceDays,
      course: { id: item.id, title: `Course ${item.id.slice(0, 1)}`, slug: `course-${item.id.slice(0, 1)}` },
    })),
  };
}

function harness() {
  const tx = {
    $queryRaw: jest.fn(),
    learningProgress: { findMany: jest.fn().mockResolvedValue([{ courseId }]) },
    membershipRemovedCourseSnapshot: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: learnerId }) },
    course: { findUnique: jest.fn().mockResolvedValue({ id: courseId }) },
    courseAccessGrant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    $transaction: jest.fn((operation) => operation(tx)),
    courseAccessGrant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const courseAccess = { ensureGrant: jest.fn(), revokeGrant: jest.fn() };
  const audit = { record: jest.fn() };
  return {
    service: new MembershipContinuityService(prisma as never, courseAccess as never, audit as never),
    prisma,
    tx,
    courseAccess,
    audit,
  };
}

describe('MembershipContinuityService', () => {
  it('grants bounded continuity only to courses started before a continuous renewal', async () => {
    const { service, tx } = harness();
    const result = await service.resolveRemovedCourses(
      tx as never,
      learnerId,
      version('old-version', [{ id: courseId, graceDays: 7 }, { id: secondCourseId, graceDays: 30 }]),
      version('new-version', []),
      termEndsAt,
      at,
    );

    expect(result).toEqual([
      expect.objectContaining({ courseId, startedBeforeRemoval: true, graceDays: 7, graceStartsAt: termEndsAt, graceEndsAt: new Date('2028-02-08T00:00:00.000Z') }),
      expect.objectContaining({ courseId: secondCourseId, startedBeforeRemoval: false, graceDays: 30, graceStartsAt: null, graceEndsAt: null }),
    ]);
    expect(tx.learningProgress.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: learnerId }),
      distinct: ['courseId'],
    }));
  });

  it('does not create grace for zero-day policy or a lapsed renewal', async () => {
    const { service, tx } = harness();
    const zero = await service.resolveRemovedCourses(
      tx as never,
      learnerId,
      version('old-version', [{ id: courseId, graceDays: 0 }]),
      version('new-version', []),
      termEndsAt,
      at,
    );
    const lapsed = await service.resolveRemovedCourses(
      tx as never,
      learnerId,
      version('old-version', [{ id: courseId, graceDays: 30 }]),
      version('new-version', []),
      new Date('2027-12-31T23:59:59.000Z'),
      at,
    );
    expect(zero[0]).toMatchObject({ startedBeforeRemoval: true, graceDays: 0, graceEndsAt: null });
    expect(lapsed[0]).toMatchObject({ startedBeforeRemoval: true, graceDays: 30, graceEndsAt: null });
  });

  it('persists immutable disclosures and activates only snapshotted grace grants idempotently', async () => {
    const { service, tx, courseAccess } = harness();
    const removed = await service.resolveRemovedCourses(
      tx as never,
      learnerId,
      version('old-version', [{ id: courseId, graceDays: 7 }]),
      version('new-version', []),
      termEndsAt,
      at,
    );
    await service.persistSnapshots(tx as never, 'checkout-intent-id', learnerId, removed);
    expect(tx.membershipRemovedCourseSnapshot.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));

    tx.membershipRemovedCourseSnapshot.findMany.mockResolvedValue([{
      id: 'snapshot-id', userId: learnerId, courseId,
      graceStartsAt: termEndsAt, graceEndsAt: new Date('2028-02-08T00:00:00.000Z'),
    }]);
    await expect(service.activateGraceGrants('checkout-intent-id', tx as never)).resolves.toBe(1);
    expect(courseAccess.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: CourseAccessSourceType.membership_grace,
      sourceId: 'snapshot-id',
      startsAt: termEndsAt,
      endsAt: new Date('2028-02-08T00:00:00.000Z'),
    }), tx);
  });

  it('reports only near-expiry grace without exposing another learner', async () => {
    const { service, prisma } = harness();
    prisma.courseAccessGrant.findMany.mockResolvedValue([{
      courseId, endsAt: new Date('2028-01-05T00:00:00.000Z'),
      course: { title: 'Course', slug: 'course' },
    }]);
    await expect(service.listExpiringGrace(learnerId, at)).resolves.toEqual([expect.objectContaining({ courseId })]);
    expect(prisma.courseAccessGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: learnerId, sourceType: CourseAccessSourceType.membership_grace }),
    }));
  });

  it('separately audits emergency revocation and leaves purchase grants outside its scope', async () => {
    const { service, tx, courseAccess, audit } = harness();
    tx.courseAccessGrant.findMany.mockResolvedValue([{
      id: 'membership-grant', userId: learnerId, courseId,
      sourceType: CourseAccessSourceType.membership,
      sourceId: 'subscription-id', status: CourseAccessGrantStatus.active,
    }]);
    await expect(service.emergencyRevoke('admin-id', {
      learnerId,
      courseId,
      kind: 'SECURITY',
      reason: 'Approved security response.',
    })).resolves.toEqual({ revokedGrantCount: 1 });
    expect(tx.courseAccessGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sourceType: { in: [CourseAccessSourceType.membership, CourseAccessSourceType.membership_grace] },
      }),
    }));
    expect(courseAccess.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: CourseAccessSourceType.membership,
    }), 'MEMBERSHIP_SECURITY', tx);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-id',
      action: AuditAction.MembershipCourseAccessEmergencyRevoked,
      metadata: expect.objectContaining({ kind: 'SECURITY', revokedGrantCount: 1 }),
    }), tx);
  });
});
