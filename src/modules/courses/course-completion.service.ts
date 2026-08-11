import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  Prisma,
  QuizStatus,
} from '../../../generated/prisma/client';

type CompletionClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'assignment' | 'enrollment' | 'lesson' | 'quiz'
>;

export interface CourseCompletionEvaluation {
  completed: boolean;
  completedRequiredItems: number;
  totalRequiredItems: number;
  enrollmentUpdated: boolean;
}

@Injectable()
export class CourseCompletionService {
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
      return {
        completed: true,
        completedRequiredItems,
        totalRequiredItems,
        enrollmentUpdated: false,
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

    return {
      completed: true,
      completedRequiredItems,
      totalRequiredItems,
      enrollmentUpdated: updated.count === 1,
    };
  }
}
