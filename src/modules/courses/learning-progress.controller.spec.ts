import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { LearningProgressController } from './learning-progress.controller';

const student = {
  id: 'student-id',
  roles: [RoleName.student],
};

describe('LearningProgressController', () => {
  function createController() {
    const service = {
      completeLesson: jest.fn().mockResolvedValue({ progressPercent: 100 }),
      getCourseProgress: jest.fn().mockResolvedValue({ progressPercent: 50 }),
    };

    return {
      controller: new LearningProgressController(service as never),
      service,
    };
  }

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

  it('requires student role for progress routes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, LearningProgressController)).toEqual([
      RoleName.student,
    ]);
  });

  it('attaches auth and role guards to progress routes', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, LearningProgressController),
    ).toBeDefined();
  });
});
