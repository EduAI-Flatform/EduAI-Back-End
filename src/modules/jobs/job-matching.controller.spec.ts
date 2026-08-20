import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { JobMatchingController } from './job-matching.controller';

describe('JobMatchingController', () => {
  const matching = { match: jest.fn() };
  const controller = new JobMatchingController(matching as never);

  it('binds matching to the authenticated learner identity', async () => {
    await controller.match('student-id', 'job-id');
    expect(matching.match).toHaveBeenCalledWith('student-id', 'job-id');
  });

  it('requires student role and both authentication guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, JobMatchingController.prototype.match)).toEqual([RoleName.student]);
    expect(Reflect.getMetadata(GUARDS_METADATA, JobMatchingController)).toHaveLength(2);
  });
});
