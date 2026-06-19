import { GUARDS_METADATA } from '@nestjs/common/constants';
import { LessonType, RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { LessonsController } from './lessons.controller';

const user = { id: 'instructor-id', roles: [RoleName.instructor] };

describe('LessonsController', () => {
  function createController() {
    const service = {
      createLesson: jest.fn().mockResolvedValue({ id: 'lesson-id' }),
      deleteLesson: jest.fn().mockResolvedValue({ deleted: true }),
      listLessons: jest.fn().mockResolvedValue([{ id: 'lesson-id' }]),
      updateLesson: jest.fn().mockResolvedValue({ id: 'lesson-id' }),
    };

    return {
      controller: new LessonsController(service as never),
      service,
    };
  }

  it('lists lessons for a public course', async () => {
    const { controller, service } = createController();

    await controller.listLessons('course-id');

    expect(service.listLessons).toHaveBeenCalledWith('course-id');
  });

  it('creates lessons for the authenticated instructor', async () => {
    const { controller, service } = createController();
    const input = {
      title: 'Introduction',
      slug: 'introduction',
      type: LessonType.article,
      orderIndex: 0,
    };

    await controller.createLesson(user, 'course-id', input);

    expect(service.createLesson).toHaveBeenCalledWith(user, 'course-id', input);
  });

  it('updates and deletes lessons through the service', async () => {
    const { controller, service } = createController();

    await controller.updateLesson(user, 'lesson-id', { orderIndex: 1 });
    await controller.deleteLesson(user, 'lesson-id');

    expect(service.updateLesson).toHaveBeenCalledWith(user, 'lesson-id', {
      orderIndex: 1,
    });
    expect(service.deleteLesson).toHaveBeenCalledWith(user, 'lesson-id');
  });

  it('requires instructor or admin roles for mutations', () => {
    for (const method of [
      LessonsController.prototype.createLesson,
      LessonsController.prototype.updateLesson,
      LessonsController.prototype.deleteLesson,
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([
        RoleName.instructor,
        RoleName.platform_admin,
      ]);
      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toBeDefined();
    }
  });
});
