import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ScholarshipsController } from './scholarships.controller';

describe('ScholarshipsController', () => {
  function createController() {
    const service = {
      createScholarship: jest.fn().mockResolvedValue({ id: 'scholarship-id' }),
      getScholarship: jest.fn().mockResolvedValue({ id: 'scholarship-id' }),
      updateScholarship: jest.fn().mockResolvedValue({ id: 'scholarship-id' }),
      preview: jest.fn().mockResolvedValue({ eligible: true }),
      apply: jest.fn().mockResolvedValue({ id: 'application-id' }),
      listApplications: jest.fn().mockResolvedValue({ items: [] }),
    };
    return { controller: new ScholarshipsController(service as never), service };
  }

  it('binds campaign creation and application to authenticated identities', async () => {
    const { controller, service } = createController();
    const createInput = { title: 'Grant' };
    const applyInput = { courseId: 'course-id' };

    await controller.createScholarship('admin-id', createInput as never);
    await controller.apply('student-id', 'scholarship-id', applyInput);

    expect(service.createScholarship).toHaveBeenCalledWith('admin-id', createInput);
    expect(service.apply).toHaveBeenCalledWith('student-id', 'scholarship-id', applyInput);
  });

  it('declares platform-admin and student role boundaries', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScholarshipsController.prototype.createScholarship)).toEqual([
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, ScholarshipsController.prototype.apply)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ScholarshipsController.prototype.apply)).toHaveLength(2);
  });
});
