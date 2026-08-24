import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MembershipAdminController } from './membership-admin.controller';

describe('MembershipAdminController authorization', () => {
  it('protects the complete membership administration boundary with platform-admin RBAC', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MembershipAdminController)).toEqual([
      RoleName.platform_admin,
    ]);
  });
});
