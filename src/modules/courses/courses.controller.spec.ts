import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CourseLevel, CourseStatus, RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CoursesController } from './courses.controller';

const user = {
  id: 'instructor-id',
  roles: [RoleName.instructor],
};

const student = {
  id: 'student-id',
  roles: [RoleName.student],
};

describe('CoursesController', () => {
  function createController() {
    const service = {
      archiveCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      completeLesson: jest.fn().mockResolvedValue({ progressPercent: 100 }),
      createCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      enrollCourse: jest.fn().mockResolvedValue({ id: 'enrollment-id' }),
      getCourse: jest.fn().mockResolvedValue({ id: 'course-id' }),
      getCourseProgress: jest.fn().mockResolvedValue({ progressPercent: 50 }),
      getMyEnrollments: jest.fn().mockResolvedValue([{ id: 'enrollment-id' }]),
      listCourses: jest.fn().mockResolvedValue([{ id: 'course-id' }]),
      listInstructorCourses: jest.fn().mockResolvedValue({
        items: [{ id: 'course-id' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
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
      level: CourseLevel.beginner,
    };
    const thumbnail = {
      buffer: Buffer.from('thumbnail'),
      mimetype: 'image/png',
      originalname: 'thumbnail.png',
      size: 9,
    };

    await controller.createCourse(user, input, thumbnail);

    expect(service.createCourse).toHaveBeenCalledWith(user, input, thumbnail);
  });

  it('lists courses for the authenticated instructor using query filters', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20, status: CourseStatus.published };

    await controller.listInstructorCourses(user, query);

    expect(service.listInstructorCourses).toHaveBeenCalledWith(user, query);
  });

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

  it('completes a lesson for the authenticated student', async () => {
    const { controller, service } = createController();

    await controller.completeLesson(student, 'lesson-id');

    expect(service.completeLesson).toHaveBeenCalledWith(student.id, 'lesson-id');
  });

  it('gets course progress for the authenticated student', async () => {
    const { controller, service } = createController();

    await controller.getCourseProgress(student, 'course-id');

    expect(service.getCourseProgress).toHaveBeenCalledWith(
      student.id,
      'course-id',
    );
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

  it('requires instructor role for instructor course listing', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.listInstructorCourses),
    ).toEqual([RoleName.instructor]);
  });

  it('requires student role for enrollment and progress routes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.enrollCourse)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.getMyEnrollments)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.completeLesson)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CoursesController.prototype.getCourseProgress)).toEqual([
      RoleName.student,
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

  it('attaches guards to course use-case routes', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.listInstructorCourses),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.enrollCourse),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.getMyEnrollments),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.completeLesson),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CoursesController.prototype.getCourseProgress),
    ).toBeDefined();
  });
});
