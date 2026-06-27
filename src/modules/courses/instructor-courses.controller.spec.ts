import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName, CourseStatus } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { InstructorCoursesController } from './instructor-courses.controller';

const user = {
  id: 'instructor-id',
  roles: [RoleName.instructor],
};

describe('InstructorCoursesController', () => {
  function createController() {
    const service = {
      listInstructorCourses: jest.fn().mockResolvedValue({
        items: [{ id: 'course-id' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    };

    return {
      controller: new InstructorCoursesController(service as never),
      service,
    };
  }

  it('lists courses for the authenticated instructor using query filters', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20, status: CourseStatus.published };

    await controller.listInstructorCourses(user, query);

    expect(service.listInstructorCourses).toHaveBeenCalledWith(user, query);
  });

  it('requires the instructor role', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, InstructorCoursesController),
    ).toEqual([RoleName.instructor]);
  });

  it('attaches auth and role guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InstructorCoursesController)).toBeDefined();
  });
});
