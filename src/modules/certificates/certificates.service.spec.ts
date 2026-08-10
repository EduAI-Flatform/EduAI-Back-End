import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../../common/audit/audit.constants';
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
  let prisma: Record<string, any>;
  prisma = {
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
      callback(prisma),
    ),
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
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    auditService,
    prisma,
    service: new CertificatesService(prisma as never, auditService as never),
  };
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
    const { auditService, prisma, service } = createService();

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
          verificationUrl: expect.stringMatching(
            /^\/api\/v1\/certificates\/verify\/CERT-/,
          ),
          qrCodeUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
        select: expect.any(Object),
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: userId,
        action: AuditAction.CertificateIssued,
        target: { type: 'certificate', id: certificate.id },
        metadata: { courseId, certificateTemplateId: templateId },
      },
      prisma,
    );
  });
});

describe('CertificatesService.verifyCertificate', () => {
  it('returns a public certificate projection without sensitive or internal fields', async () => {
    const publicCertificate = {
      certificateCode: 'CERT-abc123',
      title: 'AI Foundations',
      issuedAt: new Date('2026-07-17T00:00:00.000Z'),
      verificationUrl: '/api/v1/certificates/verify/CERT-abc123',
      courseTitle: 'AI Foundations',
      recipientName: 'Nguyễn Minh Anh',
    };
    const { service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue({
          certificateCode: publicCertificate.certificateCode,
          title: publicCertificate.title,
          issuedAt: publicCertificate.issuedAt,
          verificationUrl: publicCertificate.verificationUrl,
          course: { title: publicCertificate.courseTitle },
          user: { fullName: publicCertificate.recipientName },
          id: 'internal-id',
          metadataJson: { private: true },
        }),
        create: jest.fn(),
      },
    });

    await expect(service.verifyCertificate('CERT-abc123')).resolves.toEqual(
      publicCertificate,
    );
  });

  it('rejects an unknown certificate code', async () => {
    const { service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    });

    await expect(service.verifyCertificate('CERT-missing')).rejects.toThrow(
      'Certificate not found',
    );
  });
});

describe('CertificatesService.listMyCertificates', () => {
  it('returns only the current user certificates in newest-first order', async () => {
    const prisma = {
      certificate: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: certificate.id,
            certificateCode: certificate.certificateCode,
            title: certificate.title,
            issuedAt: certificate.issuedAt,
            verificationUrl: certificate.verificationUrl,
            qrCodeUrl: certificate.qrCodeUrl,
            course: { title: 'AI Foundations' },
          },
        ]),
      },
    };
    const service = new CertificatesService(prisma as never, {
      record: jest.fn(),
    } as never);

    await expect(service.listMyCertificates(userId)).resolves.toEqual([
      {
        id: certificate.id,
        certificateCode: certificate.certificateCode,
        title: certificate.title,
        issuedAt: certificate.issuedAt,
        verificationUrl: certificate.verificationUrl,
        qrCodeUrl: certificate.qrCodeUrl,
        courseTitle: 'AI Foundations',
      },
    ]);
    expect(prisma.certificate.findMany).toHaveBeenCalledWith({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      select: expect.objectContaining({
        course: { select: { title: true } },
      }),
    });
  });
});
