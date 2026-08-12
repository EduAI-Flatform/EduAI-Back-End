import { NotFoundException } from '@nestjs/common';
import { CourseCompletionService } from './course-completion.service';

interface CompletionCounts {
  assignments?: [number, number];
  lessons?: [number, number];
  quizzes?: [number, number];
}

function createClient(
  counts: CompletionCounts = {},
  initialEnrollment: { status: string; completedAt: Date | null } | null = {
    status: 'active',
    completedAt: null,
  },
) {
  let enrollment = initialEnrollment;
  const lessonCounts = counts.lessons ?? [1, 1];
  const quizCounts = counts.quizzes ?? [1, 1];
  const assignmentCounts = counts.assignments ?? [1, 1];
  const client = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'enrollment-id' }]),
    lesson: {
      count: jest
        .fn()
        .mockResolvedValueOnce(lessonCounts[0])
        .mockResolvedValueOnce(lessonCounts[1]),
    },
    quiz: {
      count: jest
        .fn()
        .mockResolvedValueOnce(quizCounts[0])
        .mockResolvedValueOnce(quizCounts[1]),
    },
    assignment: {
      count: jest
        .fn()
        .mockResolvedValueOnce(assignmentCounts[0])
        .mockResolvedValueOnce(assignmentCounts[1]),
    },
    enrollment: {
      findUnique: jest.fn(async () => enrollment),
      updateMany: jest.fn(async ({ data }: { data: { completedAt: Date } }) => {
        if (!enrollment || enrollment.status === 'completed') return { count: 0 };
        enrollment = {
          status: 'completed',
          completedAt: data.completedAt,
        };
        return { count: 1 };
      }),
    },
  };

  return {
    client,
    enrollment: () => enrollment,
  };
}

describe('CourseCompletionService', () => {
  const certificateIssuer = {
    issueForCompletion: jest.fn().mockResolvedValue({ id: 'certificate-id' }),
  };

  beforeEach(() => certificateIssuer.issueForCompletion.mockClear());

  it('completes an enrollment only when every required learning item is complete', async () => {
    const { client, enrollment } = createClient();
    const service = new CourseCompletionService(certificateIssuer as never);

    await expect(
      service.evaluateAndSync(client as never, 'student-id', 'course-id'),
    ).resolves.toEqual({
      completed: true,
      completedRequiredItems: 3,
      totalRequiredItems: 3,
      enrollmentUpdated: true,
    });
    expect(enrollment()).toEqual({
      status: 'completed',
      completedAt: expect.any(Date),
    });
    expect(certificateIssuer.issueForCompletion).toHaveBeenCalledWith(
      client,
      'student-id',
      'course-id',
    );
  });

  it('ignores optional items and keeps an enrollment active when a required item is incomplete', async () => {
    const { client, enrollment } = createClient({
      lessons: [2, 1],
      quizzes: [0, 0],
      assignments: [0, 0],
    });
    const service = new CourseCompletionService(certificateIssuer as never);

    await expect(
      service.evaluateAndSync(client as never, 'student-id', 'course-id'),
    ).resolves.toEqual({
      completed: false,
      completedRequiredItems: 1,
      totalRequiredItems: 2,
      enrollmentUpdated: false,
    });
    expect(enrollment()).toEqual({ status: 'active', completedAt: null });
    expect(certificateIssuer.issueForCompletion).not.toHaveBeenCalled();
    expect(client.lesson.count).toHaveBeenNthCalledWith(1, {
      where: { courseId: 'course-id', deletedAt: null, isRequired: true },
    });
    expect(client.quiz.count).toHaveBeenNthCalledWith(1, {
      where: {
        courseId: 'course-id',
        deletedAt: null,
        isRequired: true,
        status: 'published',
      },
    });
    expect(client.assignment.count).toHaveBeenNthCalledWith(1, {
      where: {
        courseId: 'course-id',
        deletedAt: null,
        isRequired: true,
        status: 'published',
      },
    });
  });

  it('does not complete an enrollment when the course has no required items', async () => {
    const { client } = createClient({
      lessons: [0, 0],
      quizzes: [0, 0],
      assignments: [0, 0],
    });
    const service = new CourseCompletionService(certificateIssuer as never);

    await expect(
      service.evaluateAndSync(client as never, 'student-id', 'course-id'),
    ).resolves.toMatchObject({
      completed: false,
      totalRequiredItems: 0,
      enrollmentUpdated: false,
    });
    expect(client.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('keeps completedAt stable across concurrent serialized evaluations', async () => {
    const { client, enrollment } = createClient();
    const service = new CourseCompletionService(certificateIssuer as never);
    let transactionQueue = Promise.resolve();
    const runTransaction = <T>(callback: () => Promise<T>): Promise<T> => {
      const result = transactionQueue.then(callback);
      transactionQueue = result.then(() => undefined);
      return result;
    };

    const firstCounts = [1, 1, 1, 1, 1, 1];
    client.lesson.count.mockResolvedValue(firstCounts[0]);
    client.quiz.count.mockResolvedValue(firstCounts[2]);
    client.assignment.count.mockResolvedValue(firstCounts[4]);
    const [first, second] = await Promise.all([
      runTransaction(() =>
        service.evaluateAndSync(client as never, 'student-id', 'course-id'),
      ),
      runTransaction(() =>
        service.evaluateAndSync(client as never, 'student-id', 'course-id'),
      ),
    ]);

    expect(first.enrollmentUpdated).toBe(true);
    expect(second.enrollmentUpdated).toBe(false);
    expect(client.enrollment.updateMany).toHaveBeenCalledTimes(1);
    expect(enrollment()?.completedAt).toEqual(expect.any(Date));
    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects evaluation when the enrollment does not exist', async () => {
    const { client } = createClient({}, null);
    const service = new CourseCompletionService(certificateIssuer as never);

    await expect(
      service.evaluateAndSync(client as never, 'student-id', 'course-id'),
    ).rejects.toEqual(new NotFoundException('Enrollment not found'));
    expect(client.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('backfills certificate issuance for an already completed enrollment', async () => {
    const { client } = createClient({}, {
      status: 'completed',
      completedAt: new Date('2026-08-12T00:00:00.000Z'),
    });
    const service = new CourseCompletionService(certificateIssuer as never);

    await expect(
      service.evaluateAndSync(client as never, 'student-id', 'course-id'),
    ).resolves.toMatchObject({ completed: true, enrollmentUpdated: false });
    expect(certificateIssuer.issueForCompletion).toHaveBeenCalledWith(
      client,
      'student-id',
      'course-id',
    );
  });
});
