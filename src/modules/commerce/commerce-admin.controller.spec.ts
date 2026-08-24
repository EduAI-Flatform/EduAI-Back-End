import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CommerceAdminController } from './commerce-admin.controller';

describe('CommerceAdminController', () => {
  it('requires platform administrator role and explicit guards for every operation', () => {
    expect(Reflect.getMetadata(ROLES_KEY, CommerceAdminController)).toEqual([
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CommerceAdminController)).toHaveLength(2);
  });

  it('binds catalog mutation audit identity to the authenticated administrator', async () => {
    const service = { updateCatalog: jest.fn().mockResolvedValue({ id: 'course-id' }) };
    const controller = new CommerceAdminController(service as never);
    const input = {
      priceAmountMinor: 250000,
      priceCurrency: 'VND' as const,
      sellable: true,
      expectedCourseUpdatedAt: '2026-08-24T00:00:00.000Z',
    };

    await controller.updateCatalog('admin-id', 'course-id', input);

    expect(service.updateCatalog).toHaveBeenCalledWith('admin-id', 'course-id', input);
  });
});
