import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName, CourseLevel } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CoursesController } from './courses.controller';

const user = {
  id: 'instructor-id',
  roles: [RoleName.instructor],
};

describe('CoursesController', () => {
  function createController() {
    const service = {
      archiveCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      createCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      getCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      listCourses: jest.fn().mockResolvedValue([{ id: 'course-id' }]),
      publishCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      updateCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
    };

    return {
      controller: new CoursesController(service as never),
      service,
    };
  }

  it('lists public courses without requiring a user', async () => {
    const { controller, service } = createController();

    await controller.listCourses();

    expect(service.listCourses).toHaveBeenCalledWith();
  });

  it('gets a course by id without requiring a user', async () => {
    const { controller, service } = createController();

    await controller.getCourse('course-id');

    expect(service.getCourse).toHaveBeenCalledWith('course-id');
  });

  it('creates a course for the authenticated instructor', async () => {
    const { controller, service } = createController();
    const input = {
      title: 'AI Foundations',
      slug: 'ai-foundations',
      level: CourseLevel.beginner,
    };

    await controller.createCourse(user, input);

    expect(service.createCourse).toHaveBeenCalledWith(user, input);
  });

  it('requires instructor or admin roles for mutations', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.createCourse)).toEqual([
      RoleName.instructor,
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.updateCourse)).toEqual([
      RoleName.instructor,
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.publishCourse)).toEqual([
      RoleName.instructor,
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.archiveCourse)).toEqual([
      RoleName.instructor,
      RoleName.platform_admin,
    ]);
  });

  it('attaches guards to mutation routes', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.createCourse),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.updateCourse),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.publishCourse),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.archiveCourse),
    ).toBeDefined();
  });
});
