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
  status: 'active',
  issuedAt: new Date('2026-07-17T00:00:00.000Z'),
  revokedAt: null,
  revocationReason: null,
  verificationUrl: null,
  qrCodeUrl: null,
  metadataJson: null,
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
};

function createService(overrides: Record<string, unknown> = {}) {
  let prisma: Record<string, any>;
  prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'enrollment-id' }]),
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
      findFirst: jest.fn().mockResolvedValue(null),
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
        findFirst: jest.fn().mockResolvedValue(certificate),
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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
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

describe('CertificatesService.issueForCompletion', () => {
  it('reports a newly issued certificate so the completion flow can notify after commit', async () => {
    const { prisma, service } = createService({
      course: { findUnique: jest.fn().mockResolvedValue({ id: courseId, title: 'AI Foundations' }) },
      certificateTemplate: { findFirst: jest.fn().mockResolvedValue({ id: templateId }) },
      certificate: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ ...certificate, status: 'active' }),
      },
    });

    await expect(
      service.issueForCompletion(prisma as never, userId, courseId),
    ).resolves.toEqual({
      certificate: expect.objectContaining({ id: certificate.id, status: 'active' }),
      issued: true,
    });
    expect(prisma.certificateTemplate.findFirst).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it('does not report issuance when an active certificate already exists', async () => {
    const activeCertificate = { ...certificate, status: 'active' };
    const { prisma, service } = createService({
      certificate: {
        findFirst: jest.fn().mockResolvedValue(activeCertificate),
        create: jest.fn(),
      },
    });

    await expect(
      service.issueForCompletion(prisma as never, userId, courseId),
    ).resolves.toEqual({ certificate: activeCertificate, issued: false });
    expect(prisma.certificate.create).not.toHaveBeenCalled();
  });
});

describe('CertificatesService.revokeCertificate', () => {
  it('revokes an active certificate with an audit trail while preserving its code', async () => {
    const revoked = {
      ...certificate,
      status: 'revoked',
      revokedAt: new Date('2026-08-12T00:00:00.000Z'),
      revocationReason: 'Course completion invalidated',
    };
    const { auditService, prisma, service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue({ id: certificate.id, status: 'active' }),
        update: jest.fn().mockResolvedValue(revoked),
      },
    });

    await expect(
      service.revokeCertificate('admin-id', certificate.id, {
        reason: 'Course completion invalidated',
      }),
    ).resolves.toEqual(revoked);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CertificateRevoked }),
      prisma,
    );
  });
});

describe('CertificatesService.verifyCertificate', () => {
  it('returns a public certificate projection without sensitive or internal fields', async () => {
    const publicCertificate = {
      certificateCode: 'CERT-abc123',
      title: 'AI Foundations',
      status: 'active' as const,
      issuedAt: new Date('2026-07-17T00:00:00.000Z'),
      revokedAt: null,
      verificationUrl: '/api/v1/certificates/verify/CERT-abc123',
      courseTitle: 'AI Foundations',
      recipientName: 'Nguyễn Minh Anh',
    };
    const { service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue({
          certificateCode: publicCertificate.certificateCode,
          title: publicCertificate.title,
          status: publicCertificate.status,
          issuedAt: publicCertificate.issuedAt,
          revokedAt: publicCertificate.revokedAt,
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
            status: certificate.status,
            issuedAt: certificate.issuedAt,
            revokedAt: certificate.revokedAt,
            revocationReason: certificate.revocationReason,
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
        status: certificate.status,
        issuedAt: certificate.issuedAt,
        revokedAt: certificate.revokedAt,
        revocationReason: certificate.revocationReason,
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

  it('keeps a revoked legacy code traceable without exposing its reason or internal fields', async () => {
    const { service } = createService({
      certificate: {
        findUnique: jest.fn().mockResolvedValue({
          certificateCode: 'EDUAI-DEMO-2026-001',
          title: 'AI Foundations',
          issuedAt: certificate.issuedAt,
          verificationUrl: null,
          status: 'revoked',
          revokedAt: new Date('2026-08-12T00:00:00.000Z'),
          course: { title: 'AI Foundations' },
          user: { fullName: 'Student Name' },
        }),
      },
    });

    const result = await service.verifyCertificate('EDUAI-DEMO-2026-001');
    expect(result).toMatchObject({
      certificateCode: 'EDUAI-DEMO-2026-001',
      status: 'revoked',
      revokedAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty('revocationReason');
    expect(result).not.toHaveProperty('email');
  });
});
