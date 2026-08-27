import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoleName } from '../../../generated/prisma/client';
import { RATE_LIMIT_KEY } from '../../common/security/rate-limit.decorator';
import { ROLES_KEY } from '../auth/roles.decorator';
import { PaymentReconciliationController } from './payment-reconciliation.controller';

describe('PaymentReconciliationController', () => {
  it('protects all review operations with platform-admin authorization', () => {
    expect(Reflect.getMetadata(ROLES_KEY, PaymentReconciliationController)).toEqual([
      RoleName.platform_admin,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, PaymentReconciliationController)).toHaveLength(2);
  });

  it('rate limits provider polling independently from review reads', () => {
    const handler = PaymentReconciliationController.prototype.run;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual({
      identity: 'user',
      limit: 4,
      name: 'payment-reconciliation-run',
      windowSeconds: 60,
    });
  });

  it('binds runner and resolution audit identity to the authenticated administrator', async () => {
    const service = {
      run: jest.fn().mockResolvedValue({ checkedCount: 0 }),
      resolve: jest.fn().mockResolvedValue({ status: 'RESOLVED' }),
    };
    const controller = new PaymentReconciliationController(service as never);
    await controller.run('admin-id', { limit: 20 });
    await controller.resolve('admin-id', '11111111-1111-4111-8111-111111111111', {
      resolution: 'acknowledged',
      expectedUpdatedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(service.run).toHaveBeenCalledWith('admin-id', { limit: 20 });
    expect(service.resolve).toHaveBeenCalledWith(
      'admin-id',
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ resolution: 'acknowledged' }),
    );
  });
});
