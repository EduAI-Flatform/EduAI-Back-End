import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
}

type CompletedEnrollment = {
  status: string;
  completedAt: Date | null;
  course: { id: string; title: string };
};

@Injectable()
export class CertificatesService {
  constructor(private readonly prisma: PrismaService) {}

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
      return await this.prisma.certificate.create({
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
    };
  }
}
