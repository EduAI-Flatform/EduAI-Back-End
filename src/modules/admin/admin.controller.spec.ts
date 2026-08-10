import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AdminController } from './admin.controller';

describe('AdminController', () => {
  it('returns the platform overview from the admin service', async () => {
    const overview = { users: { total: 12 } };
    const service = {
      getOverview: jest.fn().mockResolvedValue(overview),
    };
    const controller = new AdminController(service as never);

    await expect(controller.getOverview()).resolves.toBe(overview);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });

  it('requires authentication and the platform administrator role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toBeDefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AdminController.prototype.getOverview,
      ),
    ).toEqual([RoleName.platform_admin]);
  });
});
