import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  RoleName,
  SubmissionStatus,
} from '../../../generated/prisma/client';
import { AssignmentsService } from './assignments.service';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const student = { id: 'student-id', roles: [RoleName.student] };
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
  status: AssignmentStatus.draft,
  createdAt: dueDate,
  updatedAt: dueDate,
};

function createService() {
  const submission = {
    id: 'submission-id',
    assignmentId: assignment.id,
    userId: student.id,
    content: 'Bài làm',
    fileUrl: null,
    score: null,
    feedback: null,
    status: SubmissionStatus.submitted,
    submittedAt,
    gradedAt: null,
    gradedById: null,
    createdAt: submittedAt,
    updatedAt: submittedAt,
  };
  const prisma = {
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
      findMany: jest.fn().mockResolvedValue([submission]),
    },
  };
  return { prisma, service: new AssignmentsService(prisma as never), submission };
}

describe('AssignmentsService', () => {
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
    const { prisma, service } = createService();

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).resolves.toEqual(expect.objectContaining({ isLate: true }));
    expect(prisma.submission.create).toHaveBeenCalledWith({
      data: {
        assignmentId: assignment.id,
        userId: student.id,
        content: 'Bài làm',
        fileUrl: undefined,
        status: SubmissionStatus.submitted,
      },
      select: expect.any(Object),
    });
  });

  it('hides assignments when the student is not enrolled', async () => {
    const { prisma, service } = createService();
    prisma.assignment.findFirst.mockResolvedValue(null);

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).rejects.toEqual(new NotFoundException('Assignment not found'));
  });

  it('maps duplicate submissions to a conflict', async () => {
    const { prisma, service } = createService();
    prisma.submission.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.submitAssignment(student.id, assignment.id, { content: 'Bài làm' }),
    ).rejects.toEqual(new ConflictException('Assignment already submitted'));
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
});
