import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  NotificationCategory,
  Prisma,
  QuizStatus,
} from '../../../generated/prisma/client';
import { CertificatesService } from '../certificates/certificates.service';
import { NotificationsService } from '../notifications/notifications.service';

type CompletionClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'assignment' | 'certificate' | 'certificateTemplate' | 'course' | 'enrollment' | 'lesson' | 'quiz'
>;

export interface CourseCompletionEvaluation {
  completed: boolean;
  completedRequiredItems: number;
  totalRequiredItems: number;
  enrollmentUpdated: boolean;
  certificateIssued?: CertificateIssuedNotification;
}

export interface CertificateIssuedNotification {
  userId: string;
  certificateId: string;
  title: string;
}

@Injectable()
export class CourseCompletionService {
  constructor(
    private readonly certificatesService: CertificatesService,
    private readonly notificationsService?: NotificationsService,
  ) {}

  async evaluateAndSync(
    client: CompletionClient,
    userId: string,
    courseId: string,
  ): Promise<CourseCompletionEvaluation> {
    await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "enrollments"
      WHERE "user_id" = ${userId}::uuid
        AND "course_id" = ${courseId}::uuid
      FOR UPDATE
    `);

    const enrollment = await client.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { status: true, completedAt: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');

    const requiredLessonWhere = {
      courseId,
      deletedAt: null,
      isRequired: true,
    } satisfies Prisma.LessonWhereInput;
    const requiredQuizWhere = {
      courseId,
      deletedAt: null,
      isRequired: true,
      status: QuizStatus.published,
    } satisfies Prisma.QuizWhereInput;
    const requiredAssignmentWhere = {
      courseId,
      deletedAt: null,
      isRequired: true,
      status: AssignmentStatus.published,
    } satisfies Prisma.AssignmentWhereInput;

    const [
      requiredLessons,
      completedRequiredLessons,
      requiredQuizzes,
      completedRequiredQuizzes,
      requiredAssignments,
      completedRequiredAssignments,
    ] = await Promise.all([
      client.lesson.count({ where: requiredLessonWhere }),
      client.lesson.count({
        where: {
          ...requiredLessonWhere,
          progress: { some: { userId, status: 'completed' } },
        },
      }),
      client.quiz.count({ where: requiredQuizWhere }),
      client.quiz.count({
        where: {
          ...requiredQuizWhere,
          attempts: {
            some: { userId, submittedAt: { not: null }, passed: true },
          },
        },
      }),
      client.assignment.count({ where: requiredAssignmentWhere }),
      client.assignment.count({
        where: {
          ...requiredAssignmentWhere,
          submissions: { some: { userId } },
        },
      }),
    ]);

    const totalRequiredItems =
      requiredLessons + requiredQuizzes + requiredAssignments;
    const completedRequiredItems =
      completedRequiredLessons +
      completedRequiredQuizzes +
      completedRequiredAssignments;
    const policyComplete =
      totalRequiredItems > 0 && completedRequiredItems === totalRequiredItems;

    if (enrollment.status === 'completed') {
      const issuance = await this.certificatesService.issueForCompletion(client, userId, courseId);
      return {
        completed: true,
        completedRequiredItems,
        totalRequiredItems,
        enrollmentUpdated: false,
        ...this.toCertificateIssuedNotification(userId, issuance),
      };
    }

    if (!policyComplete || enrollment.status !== 'active') {
      return {
        completed: false,
        completedRequiredItems,
        totalRequiredItems,
        enrollmentUpdated: false,
      };
    }

    const updated = await client.enrollment.updateMany({
      where: { userId, courseId, status: 'active' },
      data: { status: 'completed', completedAt: new Date() },
    });

    const issuance = await this.certificatesService.issueForCompletion(client, userId, courseId);

    return {
      completed: true,
      completedRequiredItems,
      totalRequiredItems,
      enrollmentUpdated: updated.count === 1,
      ...this.toCertificateIssuedNotification(userId, issuance),
    };
  }

  async publishCertificateIssued(
    certificateIssued?: CertificateIssuedNotification,
  ): Promise<void> {
    if (!certificateIssued || !this.notificationsService) return;

    try {
      await this.notificationsService.createForUser({
        userId: certificateIssued.userId,
        eventKey: `certificate-issued:${certificateIssued.certificateId}`,
        type: 'certificate.issued',
        category: NotificationCategory.certificate,
        title: 'Certificate issued',
        body: `Your certificate for ${certificateIssued.title} is ready.`,
        link: '/dashboard/certificates',
      });
    } catch {
      // Completion and certificate issuance have already committed; notification delivery must not reverse them.
    }
  }

  private toCertificateIssuedNotification(
    userId: string,
    issuance: Awaited<ReturnType<CertificatesService['issueForCompletion']>>,
  ): { certificateIssued?: CertificateIssuedNotification } {
    if (!issuance.issued) return {};
    return {
      certificateIssued: {
        userId,
        certificateId: issuance.certificate.id,
        title: issuance.certificate.title,
      },
    };
  }
}
