import { TmiRedemptionController } from './tmi-redemption.controller';

describe('TmiRedemptionController', () => {
  it('binds redemption to the authenticated student and reward', async () => {
    const service = { redeem: jest.fn().mockResolvedValue({ id: 'redemption-1' }) };
    const controller = new TmiRedemptionController(service as never);

    await controller.redeem('student-1', 'reward-1', { idempotencyKey: 'request-001' });

    expect(service.redeem).toHaveBeenCalledWith('student-1', 'reward-1', { idempotencyKey: 'request-001' });
  });

  it('keeps refunds and adjustments behind the admin actor identity', async () => {
    const service = {
      refund: jest.fn().mockResolvedValue({ redemptionId: 'redemption-1' }),
      adjustBalance: jest.fn().mockResolvedValue({ userId: 'student-1' }),
    };
    const controller = new TmiRedemptionController(service as never);

    await controller.refund('admin-1', 'redemption-1', { reason: 'support correction' });
    await controller.adjustBalance('admin-1', { userId: 'student-1', amount: 10, direction: 'credit', adjustmentKey: 'adjust-001', reason: 'support correction' });

    expect(service.refund).toHaveBeenCalledWith('admin-1', 'redemption-1', { reason: 'support correction' });
    expect(service.adjustBalance).toHaveBeenCalledWith('admin-1', expect.objectContaining({ userId: 'student-1' }));
  });
});
