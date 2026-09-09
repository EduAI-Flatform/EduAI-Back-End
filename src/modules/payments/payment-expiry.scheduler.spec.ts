import { PaymentExpiryScheduler } from './payment-expiry.scheduler';

describe('PaymentExpiryScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately and then every minute only in PayOS production mode', async () => {
    const lifecycle = {
      runExpiry: jest.fn().mockResolvedValue({
        checkedCount: 0,
        expiredCount: 0,
        settledCount: 0,
        reviewRequiredCount: 0,
        hasMore: false,
        nextCursor: null,
      }),
    };
    const scheduler = new PaymentExpiryScheduler(
      lifecycle as never,
      { payos: { environment: 'production' } } as never,
    );

    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    expect(lifecycle.runExpiry).toHaveBeenCalledTimes(1);
    expect(lifecycle.runExpiry).toHaveBeenLastCalledWith(null, { limit: 20 });

    await jest.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.runExpiry).toHaveBeenCalledTimes(2);

    scheduler.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.runExpiry).toHaveBeenCalledTimes(2);
  });

  it('does not schedule provider expiry work when PayOS is disabled', async () => {
    const lifecycle = { runExpiry: jest.fn() };
    const scheduler = new PaymentExpiryScheduler(
      lifecycle as never,
      { payos: { environment: 'disabled' } } as never,
    );

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(lifecycle.runExpiry).not.toHaveBeenCalled();
  });

  it('does not overlap expiry checkpoints in the same process', async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    const firstRun = new Promise((resolve) => {
      resolveRun = resolve;
    });
    const lifecycle = {
      runExpiry: jest.fn().mockReturnValue(firstRun),
    };
    const scheduler = new PaymentExpiryScheduler(
      lifecycle as never,
      { payos: { environment: 'production' } } as never,
    );

    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.runExpiry).toHaveBeenCalledTimes(1);

    resolveRun?.({
      checkedCount: 0,
      expiredCount: 0,
      settledCount: 0,
      reviewRequiredCount: 0,
      hasMore: false,
      nextCursor: null,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.runExpiry).toHaveBeenCalledTimes(2);

    scheduler.onApplicationShutdown();
  });
});
