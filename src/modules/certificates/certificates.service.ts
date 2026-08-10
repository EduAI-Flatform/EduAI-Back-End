import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { generateCertificateQrCode } from './certificate-qr.util';
import { IssueCertificateDto } from './dto/issue-certificate.dto';

const certificateResponseSelect = {
  id: true,
  userId: true,
  courseId: true,
  certificateTemplateId: true,
  certificateCode: true,
  title: true,
  issuedAt: true,
  verificationUrl: true,
  qrCodeUrl: true,
  metadataJson: true,
  createdAt: true,
} satisfies Prisma.CertificateSelect;

const certificateVerificationSelect = {
  certificateCode: true,
  title: true,
  issuedAt: true,
  verificationUrl: true,
  course: {
    select: {
      title: true,
    },
  },
  user: {
    select: {
      fullName: true,
    },
  },
} satisfies Prisma.CertificateSelect;

const certificateListSelect = {
  id: true,
  certificateCode: true,
  title: true,
  issuedAt: true,
  verificationUrl: true,
  qrCodeUrl: true,
  course: {
    select: {
      title: true,
    },
  },
} satisfies Prisma.CertificateSelect;

export type CertificateResponse = Prisma.CertificateGetPayload<{
  select: typeof certificateResponseSelect;
}>;

export interface CertificateVerificationResponse {
  certificateCode: string;
  title: string;
  issuedAt: Date;
  verificationUrl: string | null;
  courseTitle: string;
  recipientName: string;
}

export interface CertificateListItem {
  id: string;
  certificateCode: string;
  title: string;
  issuedAt: Date;
  verificationUrl: string | null;
  qrCodeUrl: string | null;
  courseTitle: string;
}

type CompletedEnrollment = {
  status: string;
  completedAt: Date | null;
  course: { id: string; title: string };
};

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

  async issueCertificate(
    userId: string,
    input: IssueCertificateDto,
  ): Promise<CertificateResponse> {
    const enrollment = (await this.prisma.enrollment.findUnique({
      where: {
        userId_courseId: {
          userId,
          courseId: input.courseId,
        },
      },
      select: {
        status: true,
        completedAt: true,
        course: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    })) as CompletedEnrollment | null;

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.status !== 'completed' || !enrollment.completedAt) {
      throw new BadRequestException('Course must be completed before issuance');
    }

    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id: input.certificateTemplateId },
      select: { id: true },
    });

    if (!template) {
      throw new NotFoundException('Certificate template not found');
    }

    const existing = await this.prisma.certificate.findUnique({
      where: {
        userId_courseId: {
          userId,
          courseId: input.courseId,
        },
      },
      select: certificateResponseSelect,
    });

    if (existing) {
      return existing;
    }

    const certificateCode = `CERT-${randomUUID().toUpperCase()}`;
    const verificationUrl = `/api/v1/certificates/verify/${encodeURIComponent(
      certificateCode,
    )}`;
    const qrCodeUrl = await generateCertificateQrCode(verificationUrl);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const issuedCertificate = await tx.certificate.create({
          data: {
            userId,
            courseId: enrollment.course.id,
            certificateTemplateId: template.id,
            certificateCode,
            title: enrollment.course.title,
            verificationUrl,
            qrCodeUrl,
          },
          select: certificateResponseSelect,
        });
        await this.auditService.record(
          {
            actorId: userId,
            action: AuditAction.CertificateIssued,
            target: { type: 'certificate', id: issuedCertificate.id },
            metadata: {
              courseId: input.courseId,
              certificateTemplateId: input.certificateTemplateId,
            },
          },
          tx,
        );
        return issuedCertificate;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.certificate.findUnique({
          where: {
            userId_courseId: {
              userId,
              courseId: input.courseId,
            },
          },
          select: certificateResponseSelect,
        });

        if (duplicate) {
          return duplicate;
        }
      }

      throw error;
    }
  }

  async verifyCertificate(code: string): Promise<CertificateVerificationResponse> {
    const certificate = await this.prisma.certificate.findUnique({
      where: { certificateCode: code },
      select: certificateVerificationSelect,
    });

    if (!certificate) {
      throw new NotFoundException('Certificate not found');
    }

    return {
      certificateCode: certificate.certificateCode,
      title: certificate.title,
      issuedAt: certificate.issuedAt,
      verificationUrl: certificate.verificationUrl,
      courseTitle: certificate.course.title,
      recipientName: certificate.user.fullName,
    };
  }
}
