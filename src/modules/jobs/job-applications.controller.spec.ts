import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { JobApplicationsController } from './job-applications.controller';

describe('JobApplicationsController', () => {
  const service = { apply: jest.fn(), withdraw: jest.fn(), listMine: jest.fn(), listAdmin: jest.fn(), updateStatus: jest.fn() };
  const controller = new JobApplicationsController(service as never);
  it('binds learner-private operations to the authenticated user', async () => {
    await controller.apply('student-id', 'job-id', { coverLetter: null });
    await controller.withdraw('student-id', 'application-id');
    expect(service.apply).toHaveBeenCalledWith('student-id', 'job-id', { coverLetter: null });
    expect(service.withdraw).toHaveBeenCalledWith('student-id', 'application-id');
  });
  it('declares separate student and platform-admin role boundaries', () => {
    expect(Reflect.getMetadata(ROLES_KEY, JobApplicationsController.prototype.apply)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(ROLES_KEY, JobApplicationsController.prototype.listAdmin)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata(GUARDS_METADATA, JobApplicationsController)).toHaveLength(2);
  });
});
