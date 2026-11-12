import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { MembershipCheckoutController } from './membership-checkout.controller';

describe('MembershipCheckoutController authorization', () => {
  it('retires new package sales while preserving historical read endpoints', () => {
    const checkout = { createCheckout: jest.fn() };
    const controller = new MembershipCheckoutController(checkout as never);
    expect(() => controller.checkoutMembership('user', 'key', {} as never)).toThrow('Membership packages have been replaced');
    expect(checkout.createCheckout).not.toHaveBeenCalled();
  });
  it('protects the complete learner membership boundary with student RBAC', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MembershipCheckoutController)).toEqual([
      RoleName.student,
    ]);
  });
});
