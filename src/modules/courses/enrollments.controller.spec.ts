import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { EnrollmentsController } from './enrollments.controller';

const student = {
  id: 'student-id',
  roles: [RoleName.student],
};

describe('EnrollmentsController', () => {
  function createController() {
    const service = {
      enrollCourse: jest.fn().mockResolvedValue({ id: 'enrollment-id' }),
      getMyEnrollments: jest.fn().mockResolvedValue([{ id: 'enrollment-id' }]),
    };

    return {
      controller: new EnrollmentsController(service as never),
      service,
    };
  }

  it('enrolls the authenticated student in a course', async () => {
    const { controller, service } = createController();

    await controller.enrollCourse(student, 'course-id');

    expect(service.enrollCourse).toHaveBeenCalledWith(student.id, 'course-id');
  });

  it('lists enrollments for the authenticated student', async () => {
    const { controller, service } = createController();

    await controller.getMyEnrollments(student);

    expect(service.getMyEnrollments).toHaveBeenCalledWith(student.id);
  });

  it('requires student role for enrollment routes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EnrollmentsController)).toEqual([
      RoleName.student,
    ]);
  });

  it('attaches auth and role guards to enrollment routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EnrollmentsController)).toBeDefined();
  });
});
