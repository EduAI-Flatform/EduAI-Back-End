import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CertificatesService } from './certificates.service';

const userId = 'student-id';
const courseId = 'course-id';
const templateId = 'template-id';

const certificate = {
  id: 'certificate-id',
  userId,
  courseId,
  certificateTemplateId: templateId,
  certificateCode: 'CERT-existing',
  title: 'AI Foundations',
  issuedAt: new Date('2026-07-17T00:00:00.000Z'),
  verificationUrl: null,
  qrCodeUrl: null,
  metadataJson: null,
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
};

function createService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    enrollment: {
      findUnique: jest.fn().mockResolvedValue({
        status: 'completed',
        completedAt: new Date('2026-07-16T00:00:00.000Z'),
        course: { id: courseId, title: 'AI Foundations' },
      }),
    },
    certificate: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(certificate),
    },
    certificateTemplate: {
      findUnique: jest.fn().mockResolvedValue({ id: templateId }),
    },
    ...overrides,
  };

  return { prisma, service: new CertificatesService(prisma as never) };
}

describe('CertificatesService.issueCertificate', () => {
  it('rejects issuance when the enrollment is not complete', async () => {
    const { service } = createService({
      enrollment: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'active',
          completedAt: null,
          course: { id: courseId, title: 'AI Foundations' },
        }),
      },
    });

    await expect(
      service.issueCertificate(userId, { courseId, certificateTemplateId: templateId }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns the existing certificate instead of issuing a duplicate', async () => {
    const { prisma, service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue(certificate),
        create: jest.fn(),
      },
    });

    await expect(
      service.issueCertificate(userId, { courseId, certificateTemplateId: templateId }),
    ).resolves.toEqual(certificate);
    expect(prisma.certificate.create).not.toHaveBeenCalled();
  });

  it('requires an existing certificate template', async () => {
    const { service } = createService({
      certificateTemplate: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.issueCertificate(userId, { courseId, certificateTemplateId: templateId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates an immutable certificate after completion', async () => {
    const { prisma, service } = createService();

    await expect(
      service.issueCertificate(userId, { courseId, certificateTemplateId: templateId }),
    ).resolves.toEqual(certificate);
    expect(prisma.certificate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          courseId,
          certificateTemplateId: templateId,
          title: 'AI Foundations',
          certificateCode: expect.stringMatching(/^CERT-/),
        }),
        select: expect.any(Object),
      }),
    );
  });
});
