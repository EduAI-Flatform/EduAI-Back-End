import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { TmiRewardController } from './tmi-reward.controller';
describe('TmiRewardController', () => {
  it('keeps the catalog admin-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TmiRewardController)).toEqual([RoleName.platform_admin]);
    expect(Reflect.getMetadata(GUARDS_METADATA, TmiRewardController)).toHaveLength(2);
  });
});
