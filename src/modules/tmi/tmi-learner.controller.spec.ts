import { TmiLearnerController } from './tmi-learner.controller';

describe('TmiLearnerController', () => {
  it('binds wallet and history to the authenticated learner', async () => {
    const service = {
      wallet: jest.fn().mockResolvedValue({ current: 50 }),
      history: jest.fn().mockResolvedValue([]),
      listAvailableRewards: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new TmiLearnerController(service as never);

    await controller.wallet('student-1');
    await controller.history('student-1');
    await controller.listRewards({ page: 1, pageSize: 20 });

    expect(service.wallet).toHaveBeenCalledWith('student-1');
    expect(service.history).toHaveBeenCalledWith('student-1');
    expect(service.listAvailableRewards).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });
});
