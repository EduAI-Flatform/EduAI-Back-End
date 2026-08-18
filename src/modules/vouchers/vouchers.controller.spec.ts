import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { VouchersController } from './vouchers.controller';

describe('VouchersController', () => {
  function createController() {
    const service = {
      createVoucher: jest.fn().mockResolvedValue({ id: 'voucher-id' }),
      getVoucher: jest.fn().mockResolvedValue({ id: 'voucher-id' }),
      updateVoucher: jest.fn().mockResolvedValue({ id: 'voucher-id' }),
      preview: jest.fn().mockResolvedValue({ eligible: true }),
      redeem: jest.fn().mockResolvedValue({ id: 'redemption-id' }),
    };
    return { controller: new VouchersController(service as never), service };
  }

  it('routes admin creation through the actor identity', async () => {
    const { controller, service } = createController();
    const input = { code: 'EDUAI20' };

    await controller.createVoucher('admin-id', input as never);

    expect(service.createVoucher).toHaveBeenCalledWith('admin-id', input);
  });

  it('keeps preview and redemption bound to the authenticated student', async () => {
    const { controller, service } = createController();
    const input = { code: 'EDUAI20', redemptionKey: 'request-1' };

    await controller.preview('student-id', 'course-id', input);
    await controller.redeem('student-id', 'course-id', input);

    expect(service.preview).toHaveBeenCalledWith('student-id', 'course-id', 'EDUAI20');
    expect(service.redeem).toHaveBeenCalledWith('student-id', 'course-id', input);
  });

  it('declares platform-admin and student role boundaries', () => {
    expect(Reflect.getMetadata(ROLES_KEY, VouchersController.prototype.createVoucher)).toEqual([
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, VouchersController.prototype.redeem)).toEqual([
      RoleName.student,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, VouchersController.prototype.redeem)).toHaveLength(2);
  });
});
