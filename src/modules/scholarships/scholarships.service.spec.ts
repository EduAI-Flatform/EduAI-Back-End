import { BadRequestException } from '@nestjs/common';
import {
  ScholarshipApplicationStatus,
  ScholarshipBenefitKind,
  ScholarshipStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { ScholarshipsService } from './scholarships.service';

const scholarship = {
  id: 'scholarship-id',
  title: 'AI Foundations Grant',
  description: null,
  status: ScholarshipStatus.active,
  applicationMode: 'application' as const,
  benefitKind: ScholarshipBenefitKind.percentage_discount,
  benefitValue: 50,
  currency: 'VND',
  startsAt: new Date('2026-08-01T00:00:00.000Z'),
  endsAt: new Date('2026-09-01T00:00:00.000Z'),
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
  return { service: new ScholarshipsService(prisma as never, auditService as never), tx, auditService, application };
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

  it('rejects a quota-exhausted campaign before writing an application', async () => {
    const { service, tx } = createHarness();
    tx.scholarshipCampaign.findUnique.mockResolvedValueOnce({ ...scholarship, awardedCount: 1 });

    await expect(service.apply('student-id', scholarship.id, { courseId: course.id })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.scholarshipApplication.create).not.toHaveBeenCalled();
    expect(tx.scholarshipCampaign.update).not.toHaveBeenCalled();
  });
});
