import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { generateCertificateQrCode } from './certificate-qr.util';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import { RevokeCertificateDto } from './dto/revoke-certificate.dto';

const certificateResponseSelect = {
  id: true,
  userId: true,
  courseId: true,
  certificateTemplateId: true,
  certificateCode: true,
  title: true,
  status: true,
  issuedAt: true,
  revokedAt: true,
  revocationReason: true,
  verificationUrl: true,
  qrCodeUrl: true,
  metadataJson: true,
  createdAt: true,
} satisfies Prisma.CertificateSelect;

const certificateVerificationSelect = {
  certificateCode: true,
  title: true,
  status: true,
  issuedAt: true,
  revokedAt: true,
  verificationUrl: true,
  course: { select: { title: true } },
  user: { select: { fullName: true } },
} satisfies Prisma.CertificateSelect;

const certificateListSelect = {
  id: true,
  certificateCode: true,
  title: true,
  status: true,
  issuedAt: true,
  revokedAt: true,
  revocationReason: true,
  verificationUrl: true,
  qrCodeUrl: true,
  course: { select: { title: true } },
} satisfies Prisma.CertificateSelect;

export type CertificateResponse = Prisma.CertificateGetPayload<{
  select: typeof certificateResponseSelect;
}>;

export interface CertificateVerificationResponse {
  certificateCode: string;
  title: string;
  status: 'active' | 'revoked';
  issuedAt: Date;
  revokedAt: Date | null;
  verificationUrl: string | null;
  courseTitle: string;
  recipientName: string;
}

export interface CertificateListItem {
  id: string;
  certificateCode: string;
  title: string;
  status: 'active' | 'revoked';
  issuedAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  verificationUrl: string | null;
  qrCodeUrl: string | null;
  courseTitle: string;
}

type CompletedEnrollment = {
  status: string;
  completedAt: Date | null;
  course: { id: string; title: string };
};

type CertificateClient = Pick<
  Prisma.TransactionClient,
  'certificate' | 'certificateTemplate' | 'course'
>;

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listMyCertificates(userId: string): Promise<CertificateListItem[]> {
    const certificates = await this.prisma.certificate.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      select: certificateListSelect,
    });
    return certificates.map(({ course, ...certificate }) => ({
      ...certificate,
      courseTitle: course.title,
    }));
  }

  async issueCertificate(userId: string, input: IssueCertificateDto): Promise<CertificateResponse> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: input.courseId } },
      select: {
        status: true,
        completedAt: true,
        course: { select: { id: true, title: true } },
      },
    }) as CompletedEnrollment | null;
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== 'completed' || !enrollment.completedAt) {
      throw new BadRequestException('Course must be completed before issuance');
    }
    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id: input.certificateTemplateId },
      select: { id: true },
    });
    if (!template) throw new NotFoundException('Certificate template not found');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "enrollments"
          WHERE "user_id" = ${userId}::uuid AND "course_id" = ${input.courseId}::uuid
          FOR UPDATE
        `);
        const existing = await this.findActive(tx, userId, input.courseId);
        if (existing) return existing;
        return this.createCertificate(tx, userId, enrollment.course, template.id);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.findActive(this.prisma, userId, input.courseId);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  async issueForCompletion(
    client: CertificateClient,
    userId: string,
    courseId: string,
  ): Promise<CertificateResponse> {
    const existing = await this.findActive(client, userId, courseId);
    if (existing) return existing;
    const [course, template] = await Promise.all([
      client.course.findUnique({ where: { id: courseId }, select: { id: true, title: true } }),
      client.certificateTemplate.findFirst({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    ]);
    if (!course) throw new NotFoundException('Course not found');
    if (!template) throw new NotFoundException('Certificate template not found');
    return this.createCertificate(client, userId, course, template.id);
  }

  async revokeCertificate(
    actorId: string,
    certificateId: string,
    input: RevokeCertificateDto,
  ): Promise<CertificateResponse> {
    const certificate = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      select: { id: true, status: true },
    });
    if (!certificate) throw new NotFoundException('Certificate not found');
    if (certificate.status === 'revoked') {
      return this.prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: certificateResponseSelect,
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.certificate.update({
        where: { id: certificateId },
        data: { status: 'revoked', revokedAt: new Date(), revocationReason: input.reason },
        select: certificateResponseSelect,
      });
      await this.auditService.record({
        actorId,
        action: AuditAction.CertificateRevoked,
        target: { type: 'certificate', id: certificateId },
        metadata: { reason: input.reason },
      }, tx);
      return revoked;
    });
  }

  async verifyCertificate(code: string): Promise<CertificateVerificationResponse> {
    const certificate = await this.prisma.certificate.findUnique({
      where: { certificateCode: code },
      select: certificateVerificationSelect,
    });
    if (!certificate) throw new NotFoundException('Certificate not found');
    return {
      certificateCode: certificate.certificateCode,
      title: certificate.title,
      status: certificate.status,
      issuedAt: certificate.issuedAt,
      revokedAt: certificate.revokedAt,
      verificationUrl: certificate.verificationUrl,
      courseTitle: certificate.course.title,
      recipientName: certificate.user.fullName,
    };
  }

  private findActive(client: CertificateClient, userId: string, courseId: string) {
    return client.certificate.findFirst({
      where: { userId, courseId, status: 'active' },
      select: certificateResponseSelect,
    });
  }

  private async createCertificate(
    client: CertificateClient,
    userId: string,
    course: { id: string; title: string },
    certificateTemplateId: string,
  ): Promise<CertificateResponse> {
    const certificateCode = `CERT-${randomUUID().toUpperCase()}`;
    const verificationUrl = `/api/v1/certificates/verify/${encodeURIComponent(certificateCode)}`;
    const qrCodeUrl = await generateCertificateQrCode(verificationUrl);
    const issued = await client.certificate.create({
      data: {
        userId,
        courseId: course.id,
        certificateTemplateId,
        certificateCode,
        title: course.title,
        verificationUrl,
        qrCodeUrl,
      },
      select: certificateResponseSelect,
    });
    await this.auditService.record({
      actorId: userId,
      action: AuditAction.CertificateIssued,
      target: { type: 'certificate', id: issued.id },
      metadata: { courseId: course.id, certificateTemplateId },
    }, client as Prisma.TransactionClient);
    return issued;
  }
}
