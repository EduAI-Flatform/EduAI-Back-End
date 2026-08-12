import { GUARDS_METADATA } from '@nestjs/common/constants';
import { LessonType, RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { LessonsController } from './lessons.controller';

const user = { id: 'instructor-id', roles: [RoleName.instructor] };

describe('LessonsController', () => {
  function createController() {
    const service = {
      createLesson: jest.fn().mockResolvedValue({ id: 'lesson-id' }),
      authorizeVideoUpload: jest.fn().mockResolvedValue({ uploadUrl: 'signed' }),
      finalizeVideoUpload: jest.fn().mockResolvedValue({ storageKey: 'key' }),
      uploadDocument: jest.fn().mockResolvedValue({ storageKey: 'key' }),
      deleteLesson: jest.fn().mockResolvedValue({ deleted: true }),
      discardMedia: jest.fn().mockResolvedValue({ deleted: true }),
      getLesson: jest.fn().mockResolvedValue({ id: 'lesson-id' }),
      listInstructorLessons: jest.fn().mockResolvedValue([{ id: 'lesson-id' }]),
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

  it('returns a lesson detail for an anonymous or authenticated viewer', async () => {
    const { controller, service } = createController();

    await controller.getLesson(undefined, 'lesson-id');
    await controller.getLesson(user, 'lesson-id');

    expect(service.getLesson).toHaveBeenNthCalledWith(1, undefined, 'lesson-id');
    expect(service.getLesson).toHaveBeenNthCalledWith(2, user, 'lesson-id');
  });

  it('lists instructor lessons for an owned course', async () => {
    const { controller, service } = createController();

    await controller.listInstructorLessons(user, 'course-id');

    expect(service.listInstructorLessons).toHaveBeenCalledWith(user, 'course-id');
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
      LessonsController.prototype.listInstructorLessons,
      LessonsController.prototype.authorizeVideoUpload,
      LessonsController.prototype.finalizeVideoUpload,
      LessonsController.prototype.uploadDocument,
      LessonsController.prototype.discardMedia,
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

  it('delegates media authorization and upload with course context', async () => {
    const { controller, service } = createController();
    await controller.authorizeVideoUpload(user, 'course-id', {
      mimeType: 'video/mp4',
      size: 1024,
    });
    await controller.finalizeVideoUpload(user, 'course-id', {
      storageKey: 'key',
      mimeType: 'video/mp4',
      size: 1024,
    });
    const file = { buffer: Buffer.from('%PDF-'), size: 5, mimetype: 'application/pdf' };
    await controller.uploadDocument(user, 'course-id', file);
    await controller.discardMedia(user, 'course-id', { storageKey: 'key' });

    expect(service.authorizeVideoUpload).toHaveBeenCalledWith(user, 'course-id', 'video/mp4', 1024);
    expect(service.finalizeVideoUpload).toHaveBeenCalledWith(user, 'course-id', 'key', 'video/mp4', 1024);
    expect(service.uploadDocument).toHaveBeenCalledWith(user, 'course-id', file);
    expect(service.discardMedia).toHaveBeenCalledWith(user, 'course-id', 'key');
  });

  it('uses optional authentication for lesson detail access', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        LessonsController.prototype.getLesson,
      ),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(ROLES_KEY, LessonsController.prototype.getLesson),
    ).toBeUndefined();
  });
});
