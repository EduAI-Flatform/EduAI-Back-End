import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { JobsController } from './jobs.controller';

describe('JobsController', () => {
  const service = {
    create: jest.fn().mockResolvedValue({ id: 'job-id' }),
    update: jest.fn().mockResolvedValue({ id: 'job-id' }),
    publish: jest.fn().mockResolvedValue({ id: 'job-id' }),
    close: jest.fn().mockResolvedValue({ id: 'job-id' }),
    remove: jest.fn().mockResolvedValue({ deleted: true }),
  };
  const controller = new JobsController(service as never);

  it('binds every admin mutation to the authenticated actor', async () => {
    await controller.create('admin-id', { title: 'Role' } as never);
    await controller.publish('admin-id', 'job-id');
    await controller.close('admin-id', 'job-id');
    await controller.remove('admin-id', 'job-id');
    expect(service.create).toHaveBeenCalledWith('admin-id', expect.any(Object));
    expect(service.publish).toHaveBeenCalledWith('admin-id', 'job-id');
    expect(service.close).toHaveBeenCalledWith('admin-id', 'job-id');
    expect(service.remove).toHaveBeenCalledWith('admin-id', 'job-id');
  });

  it('requires the platform administrator role and both auth guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, JobsController.prototype.create)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata(GUARDS_METADATA, JobsController.prototype.create)).toHaveLength(2);
    expect(Reflect.getMetadata(ROLES_KEY, JobsController.prototype.publish)).toEqual([RoleName.platform_admin]);
  });
});
