import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ServiceEntitlementController } from './service-entitlement.controller';

describe('ServiceEntitlementController authorization', () => {
  it('allows only authenticated learners to read their own injected-user entitlement view', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, ServiceEntitlementController)).toEqual([
      RoleName.student,
    ]);
    const service = { listForUser: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new ServiceEntitlementController(service as never);
    await controller.listOwn('student-id');
    expect(service.listForUser).toHaveBeenCalledWith('student-id');
  });
});
