import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { ServiceEntitlementController } from './service-entitlement.controller';

describe('ServiceEntitlementController authorization', () => {
  it('requires authentication for any account role to read only its injected-user quota view', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ServiceEntitlementController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, ServiceEntitlementController)).toBeUndefined();
    const service = { listForUser: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new ServiceEntitlementController(service as never);
    await controller.listOwn('student-id');
    expect(service.listForUser).toHaveBeenCalledWith('student-id');
  });
});
