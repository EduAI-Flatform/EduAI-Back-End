import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MembershipCheckoutController } from './membership-checkout.controller';

describe('MembershipCheckoutController authorization', () => {
  it('protects the complete learner membership boundary with student RBAC', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MembershipCheckoutController)).toEqual([
      RoleName.student,
    ]);
  });
});
