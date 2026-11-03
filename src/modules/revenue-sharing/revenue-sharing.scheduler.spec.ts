import { RevenueSharingScheduler } from './revenue-sharing.scheduler';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';
import { Logger } from '@nestjs/common';

describe('revenue scheduler recovery', () => {
  afterEach(() => jest.restoreAllMocks());
  it('recovers on the next run and does not let catalog failures suppress finance processing', async () => {
    jest.spyOn(Logger.prototype,'warn').mockImplementation(() => undefined);
    const memberships={reconcileDue:jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({activated:0})};
    const finance={runBatch:jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({checked:0,failed:0})};
    const worker=new RevenueSharingScheduler(finance as unknown as RevenueFinanceService,memberships as unknown as RevenueMembershipService);
    await worker.runOnce(); await worker.runOnce();
    expect(memberships.reconcileDue).toHaveBeenCalledTimes(2);
    expect(finance.runBatch).toHaveBeenCalledTimes(2);
  });
  it('skips overlapping runs and releases its in-flight guard after completion', async () => {
    let release!: () => void;
    const gate=new Promise<void>(resolve => {release=resolve;});
    const memberships={reconcileDue:jest.fn().mockReturnValueOnce(gate).mockResolvedValue({activated:0})};
    const finance={runBatch:jest.fn().mockResolvedValue({checked:0,failed:0})};
    const worker=new RevenueSharingScheduler(finance as unknown as RevenueFinanceService,memberships as unknown as RevenueMembershipService);
    const first=worker.runOnce();
    await worker.runOnce();
    expect(memberships.reconcileDue).toHaveBeenCalledTimes(1);
    release(); await first; await worker.runOnce();
    expect(finance.runBatch).toHaveBeenCalledTimes(2);
  });
});