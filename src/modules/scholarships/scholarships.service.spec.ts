import { BadRequestException } from '@nestjs/common';
import {
  ScholarshipApplicationStatus,
  ScholarshipBenefitKind,
  ScholarshipStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { ScholarshipsService } from './scholarships.service';

const testNow = new Date();
const activeWindowStart = new Date(testNow.getTime() - 24 * 60 * 60 * 1000);
const activeWindowEnd = new Date(testNow.getTime() + 24 * 60 * 60 * 1000);

const scholarship = {
  id: 'scholarship-id',
  title: 'AI Foundations Grant',
  description: null,
  status: ScholarshipStatus.active,
  applicationMode: 'application' as const,
  benefitKind: ScholarshipBenefitKind.percentage_discount,
  benefitValue: 50,
  currency: 'VND',
  startsAt: activeWindowStart,
  endsAt: activeWindowEnd,
  quota: 1,
  awardedCount: 0,
  createdById: 'admin-id',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  courseScopes: [],
  categoryScopes: [{ categorySlug: 'ai-foundations' }],
  eligibleUsers: [],
};

const course = { id: 'course-id', categorySlug: 'ai-foundations' };

function createHarness() {
  const application = {
    id: 'application-id',
    scholarshipId: scholarship.id,
    userId: 'student-id',
    courseId: course.id,
    status: ScholarshipApplicationStatus.awarded,
    decisionReason: null,
    appliedAt: new Date('2026-08-18T00:00:00.000Z'),
    updatedAt: new Date('2026-08-18T00:00:00.000Z'),
    award: {
      id: 'award-id',
      benefitKind: scholarship.benefitKind,
      benefitValue: scholarship.benefitValue,
      currency: scholarship.currency,
      awardedAt: new Date('2026-08-18T00:00:00.000Z'),
      revokedAt: null,
    },
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: scholarship.id }]),
    scholarshipCampaign: {
      findUnique: jest.fn().mockResolvedValue(scholarship),
      update: jest.fn().mockResolvedValue({ ...scholarship, awardedCount: 1 }),
    },
    scholarshipApplication: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(application),
    },
    course: { findFirst: jest.fn().mockResolvedValue(course) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const courseAccess = { ensureGrant: jest.fn().mockResolvedValue({ id: 'grant-id' }) };
  return { service: new ScholarshipsService(prisma as never, auditService as never, courseAccess as never), tx, auditService, application, courseAccess };
}

describe('ScholarshipsService.apply', () => {
  it('locks the campaign and records one awarded application', async () => {
    const { service, tx, auditService } = createHarness();

    await expect(service.apply('student-id', scholarship.id, { courseId: course.id })).resolves.toMatchObject({
      id: 'application-id',
      status: ScholarshipApplicationStatus.awarded,
      idempotent: false,
    });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.scholarshipApplication.create).toHaveBeenCalled();
    expect(tx.scholarshipCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { awardedCount: { increment: 1 } } }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.ScholarshipApplied }),
      tx,
    );
  });

  it('returns an existing application without awarding twice', async () => {
    const { service, tx, application } = createHarness();
    tx.scholarshipApplication.findUnique.mockResolvedValueOnce(application);

    await expect(service.apply('student-id', scholarship.id, { courseId: course.id })).resolves.toMatchObject({
      id: application.id,
      idempotent: true,
    });

    expect(tx.scholarshipApplication.create).not.toHaveBeenCalled();
    expect(tx.scholarshipCampaign.update).not.toHaveBeenCalled();
  });

  it('creates the course grant atomically for a course-access award', async () => {
    const { service, tx, application, courseAccess } = createHarness();
    tx.scholarshipCampaign.findUnique.mockResolvedValueOnce({
      ...scholarship,
      benefitKind: ScholarshipBenefitKind.course_access,
      benefitValue: 100,
      currency: null,
    });
    tx.scholarshipApplication.create.mockResolvedValueOnce({
      ...application,
      award: { ...application.award, benefitKind: ScholarshipBenefitKind.course_access, benefitValue: 100, currency: null },
    });

    await service.apply('student-id', scholarship.id, { courseId: course.id });

    expect(courseAccess.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'student-id',
      courseId: course.id,
      sourceType: 'scholarship',
      sourceId: 'award-id',
    }), tx);
  });

  it('rejects a quota-exhausted campaign before writing an application', async () => {
    const { service, tx } = createHarness();
    tx.scholarshipCampaign.findUnique.mockResolvedValueOnce({ ...scholarship, awardedCount: 1 });

    await expect(service.apply('student-id', scholarship.id, { courseId: course.id })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.scholarshipApplication.create).not.toHaveBeenCalled();
    expect(tx.scholarshipCampaign.update).not.toHaveBeenCalled();
  });
});
