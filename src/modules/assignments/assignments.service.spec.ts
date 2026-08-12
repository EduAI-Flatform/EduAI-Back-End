import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AssignmentsService } from './assignments.service';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const student = { id: 'student-id', roles: [RoleName.student] };
const studentProfile = {
  id: student.id,
  fullName: 'Nguyễn Minh Anh',
  avatarUrl: '/demo/avatars/student.svg',
};
const dueDate = new Date('2026-07-01T00:00:00.000Z');
const submittedAt = new Date('2026-07-02T00:00:00.000Z');
const course = { id: 'course-id', instructorId: instructor.id };
const assignment = {
  id: 'assignment-id',
  courseId: course.id,
  lessonId: null,
  title: 'Bài tập AI',
  description: null,
  dueDate,
  maxScore: 10,
  isRequired: true,
  status: AssignmentStatus.draft,
  createdAt: dueDate,
  updatedAt: dueDate,
};

function createService(storage?: { upload: jest.Mock; createDownloadUrl?: jest.Mock }) {
  const submission = {
    id: 'submission-id',
    assignmentId: assignment.id,
    userId: student.id,
    content: 'Bài làm',
    fileUrl: null,
    version: 1,
    isLate: true,
    rubricScores: null,
    score: null,
    feedback: null,
    status: SubmissionStatus.submitted,
    submittedAt,
    gradedAt: null,
    gradedById: null,
    createdAt: submittedAt,
    updatedAt: submittedAt,
    user: studentProfile,
  };
  let prisma: Record<string, any>;
  prisma = {
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
      callback(prisma),
    ),
    $queryRaw: jest.fn().mockResolvedValue([]),
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    lesson: { findFirst: jest.fn() },
    assignment: {
      create: jest.fn().mockResolvedValue(assignment),
      findFirst: jest.fn().mockResolvedValue({
        ...assignment,
        status: AssignmentStatus.published,
        course,
      }),
      findMany: jest.fn().mockResolvedValue([assignment]),
      update: jest.fn().mockResolvedValue(assignment),
    },
    submission: {
      create: jest.fn().mockResolvedValue(submission),
      findFirst: jest.fn().mockResolvedValue({
        ...submission,
        assignment: { ...assignment, course },
      }),
      findMany: jest.fn().mockResolvedValue([submission]),
      update: jest.fn().mockResolvedValue({
        ...submission,
        score: 8,
        feedback: 'Good work',
        status: SubmissionStatus.graded,
        gradedAt: submittedAt,
        gradedById: instructor.id,
      }),
    },
  };
  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };
  const completionService = {
    evaluateAndSync: jest.fn().mockResolvedValue(undefined),
  };
  return {
    auditService,
    completionService,
    prisma,
    service: new AssignmentsService(
      prisma as never,
      auditService as never,
      completionService as never,
      undefined,
      storage as never,
    ),
    submission,
  };
}

describe('AssignmentsService', () => {
  it('audits assignment publication', async () => {
    const { auditService, prisma, service } = createService();

    await service.publishAssignment(instructor, assignment.id);

    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: instructor.id,
        action: AuditAction.AssignmentPublished,
        target: { type: 'assignment', id: assignment.id },
        metadata: { status: AssignmentStatus.published },
      },
      prisma,
    );
  });

  it('creates draft assignments for an owned course', async () => {
    const { prisma, service } = createService();

    await service.createAssignment(instructor, course.id, {
      title: assignment.title,
      maxScore: assignment.maxScore,
      dueDate: dueDate.toISOString(),
    });

    expect(prisma.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        courseId: course.id,
        title: assignment.title,
        maxScore: assignment.maxScore,
        status: AssignmentStatus.draft,
      }),
      select: expect.any(Object),
    });
  });

  it('stores enrolled student submissions and flags late work', async () => {
    const { completionService, prisma, service } = createService();

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).resolves.toEqual(
      expect.objectContaining({
        isLate: true,
        student: studentProfile,
      }),
    );
    expect(prisma.submission.create).toHaveBeenCalledWith({
      data: {
        assignmentId: assignment.id,
        userId: student.id,
        content: 'Bài làm',
        fileUrl: null,
        version: 2,
        isLate: true,
        submittedAt: expect.any(Date),
        status: SubmissionStatus.submitted,
      },
      select: expect.any(Object),
    });
    expect(completionService.evaluateAndSync).toHaveBeenCalledWith(
      prisma,
      student.id,
      course.id,
    );
  });

  it('stores uploaded assignment metadata with a private object key', async () => {
    const storage = {
      upload: jest.fn().mockResolvedValue({
        key: 'assignments/file-id.pdf',
      }),
      createDownloadUrl: jest.fn(),
    };
    const { prisma, service } = createService(storage);
    prisma.submission.findFirst.mockResolvedValue(null);
    const file = {
      buffer: Buffer.from('%PDF-1.7'),
      mimetype: 'application/pdf',
      originalname: 'bai-lam.pdf',
      size: 8,
    };

    await service.submitAssignment(student.id, assignment.id, {}, file);

    expect(storage.upload).toHaveBeenCalledWith(file, {
      allowedMimeTypes: undefined,
      maxFileSizeBytes: undefined,
    });
    expect(prisma.submission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fileUrl: null,
        fileKey: 'assignments/file-id.pdf',
        fileName: 'bai-lam.pdf',
        fileSize: 8,
        fileMimeType: 'application/pdf',
      }),
      select: expect.any(Object),
    });
  });

  it('returns student identity with instructor submission lists', async () => {
    const { service } = createService();

    await expect(
      service.listSubmissions(instructor, assignment.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'submission-id',
        userId: student.id,
        student: studentProfile,
      }),
    ]);
  });

  it('hides assignments when the student is not enrolled', async () => {
    const { prisma, service } = createService();
    prisma.assignment.findFirst.mockResolvedValue(null);

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).rejects.toEqual(new NotFoundException('Assignment not found'));
  });

  it('creates a new immutable submission version for resubmission', async () => {
    const { prisma, service } = createService();

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).resolves.toEqual(expect.objectContaining({ id: 'submission-id' }));
    expect(prisma.submission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2, isLate: true }),
      }),
    );
  });

  it('returns the authenticated student submission with grade state', async () => {
    const { prisma, service } = createService();

    await expect(
      service.getMySubmission(student.id, assignment.id),
    ).resolves.toEqual(expect.objectContaining({
      id: 'submission-id',
      assignmentId: assignment.id,
      userId: student.id,
      isLate: true,
    }));
    expect(prisma.submission.findFirst).toHaveBeenCalledWith({
      where: {
        assignmentId: assignment.id,
        userId: student.id,
        assignment: {
          deletedAt: null,
          status: AssignmentStatus.published,
          course: {
            deletedAt: null,
            status: 'published',
            enrollments: { some: { userId: student.id } },
          },
        },
      },
      orderBy: { version: 'desc' },
      select: expect.objectContaining({
        assignment: { select: { finalScorePolicy: true } },
      }),
    });
  });

  it('allows a multi-role user to read assignments through student enrollment', async () => {
    const { prisma, service } = createService();
    const multiRoleUser = {
      id: student.id,
      roles: [RoleName.instructor, RoleName.student],
    };
    prisma.course.findFirst.mockResolvedValue({
      id: course.id,
      instructorId: 'another-instructor',
      status: AssignmentStatus.published,
      enrollments: [{ id: 'enrollment-id' }],
    });

    await expect(
      service.listAssignments(multiRoleUser, course.id),
    ).resolves.toEqual([assignment]);
  });

  it('grades submissions for the owning instructor', async () => {
    const { auditService, prisma, service } = createService();

    await expect(
      service.gradeSubmission(instructor, 'submission-id', {
        score: 8,
        feedback: 'Good work',
      }),
    ).resolves.toEqual(expect.objectContaining({
      score: 8,
      feedback: 'Good work',
      status: SubmissionStatus.graded,
      gradedById: instructor.id,
      isLate: true,
    }));
    expect(prisma.submission.update).toHaveBeenCalledWith({
      where: { id: 'submission-id' },
      data: expect.objectContaining({
        score: 8,
        feedback: 'Good work',
        status: SubmissionStatus.graded,
        gradedById: instructor.id,
      }),
      select: expect.any(Object),
    });
    expect(auditService.record).toHaveBeenCalledWith(
      {
        actorId: instructor.id,
        action: AuditAction.SubmissionGraded,
        target: { type: 'submission', id: 'submission-id' },
        metadata: {
          assignmentId: assignment.id,
          score: 8,
          status: SubmissionStatus.graded,
        },
      },
      prisma,
    );
  });

  it('derives rubric grades from the configured criteria', async () => {
    const { prisma, service } = createService();
    prisma.submission.findFirst.mockResolvedValue({
      ...prisma.submission.findFirst.mock.results[0]?.value,
      ...createService().submission,
      assignment: {
        ...assignment,
        course,
        rubricCriteria: [{ criterion: 'Correctness', maxScore: 5 }],
      },
    });

    await service.gradeSubmission(instructor, 'submission-id', {
      score: 0,
      rubricScores: [{ criterion: 'Correctness', score: 4 }],
    });

    expect(prisma.submission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ score: 4, rubricScores: [{ criterion: 'Correctness', score: 4 }] }),
      }),
    );
  });

  it('uses the configured highest-score policy for the final student result', async () => {
    const { prisma, service, submission } = createService();
    const highest = { ...submission, score: 9, status: SubmissionStatus.graded };
    prisma.submission.findFirst
      .mockResolvedValueOnce({
        ...submission,
        assignment: { finalScorePolicy: 'highest' },
      })
      .mockResolvedValueOnce(highest);

    await expect(service.getMySubmission(student.id, assignment.id)).resolves.toEqual(
      expect.objectContaining({ score: 9, status: SubmissionStatus.graded }),
    );
    expect(prisma.submission.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SubmissionStatus.graded }),
        orderBy: [{ score: 'desc' }, { version: 'desc' }],
      }),
    );
  });

  it('hides assignment submissions from non-owning instructors', async () => {
    const { prisma, service } = createService();
    const otherInstructor = {
      id: 'other-instructor-id',
      roles: [RoleName.instructor],
    };

    await expect(
      service.listSubmissions(otherInstructor, assignment.id),
    ).rejects.toEqual(new NotFoundException('Assignment not found'));

    expect(prisma.submission.findMany).not.toHaveBeenCalled();
  });

  it('rejects student grading through ownership checks', async () => {
    const { service } = createService();

    await expect(
      service.gradeSubmission(student, 'submission-id', { score: 8 }),
    ).rejects.toEqual(new NotFoundException('Submission not found'));
  });

  it('rejects grades above the assignment max score', async () => {
    const { service } = createService();

    await expect(
      service.gradeSubmission(instructor, 'submission-id', { score: 11 }),
    ).rejects.toEqual(
      new BadRequestException('Score cannot exceed assignment max score'),
    );
  });
});
