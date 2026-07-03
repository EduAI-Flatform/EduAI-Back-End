import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AssignmentsController } from './assignments.controller';

const instructor = { id: 'instructor-id', roles: [RoleName.instructor] };
const student = { id: 'student-id', roles: [RoleName.student] };

describe('AssignmentsController', () => {
  function createController() {
    const service = {
      createAssignment: jest.fn().mockResolvedValue({ id: 'assignment-id' }),
      listAssignments: jest.fn().mockResolvedValue([]),
      getAssignment: jest.fn().mockResolvedValue({ id: 'assignment-id' }),
      updateAssignment: jest.fn().mockResolvedValue({ id: 'assignment-id' }),
      deleteAssignment: jest.fn().mockResolvedValue({ deleted: true }),
      publishAssignment: jest.fn().mockResolvedValue({ id: 'assignment-id' }),
      submitAssignment: jest.fn().mockResolvedValue({ id: 'submission-id' }),
      getMySubmission: jest.fn().mockResolvedValue({ id: 'submission-id' }),
      listSubmissions: jest.fn().mockResolvedValue([]),
      gradeSubmission: jest.fn().mockResolvedValue({ id: 'submission-id' }),
    };
    return { controller: new AssignmentsController(service as never), service };
  }

  it('delegates management and submission using authenticated users', async () => {
    const { controller, service } = createController();
    const assignmentInput = { title: 'Bài tập', maxScore: 10 };
    const submissionInput = { content: 'Bài làm' };

    await controller.createAssignment(instructor, 'course-id', assignmentInput);
    await controller.submitAssignment(student, 'assignment-id', submissionInput);
    await controller.getMySubmission(student, 'assignment-id');
    await controller.gradeSubmission(instructor, 'submission-id', { score: 8 });

    expect(service.createAssignment).toHaveBeenCalledWith(
      instructor,
      'course-id',
      assignmentInput,
    );
    expect(service.submitAssignment).toHaveBeenCalledWith(
      student.id,
      'assignment-id',
      submissionInput,
    );
    expect(service.getMySubmission).toHaveBeenCalledWith(
      student.id,
      'assignment-id',
    );
    expect(service.gradeSubmission).toHaveBeenCalledWith(
      instructor,
      'submission-id',
      { score: 8 },
    );
  });

  it('requires guards and separates manager from student routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AssignmentsController)).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AssignmentsController.prototype.createAssignment,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AssignmentsController.prototype.submitAssignment,
      ),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AssignmentsController.prototype.getMySubmission,
      ),
    ).toEqual([RoleName.student]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AssignmentsController.prototype.gradeSubmission,
      ),
    ).toEqual([RoleName.instructor, RoleName.platform_admin]);
  });
});
