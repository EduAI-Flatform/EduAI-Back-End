import { HealthService } from './health.service';

describe('HealthService', () => {
  function createService(statuses: Partial<Record<string, string>> = {}) {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { checkHealth: jest.fn().mockResolvedValue({ status: statuses.redis ?? 'ok' }) };
    const storage = { checkHealth: jest.fn().mockResolvedValue(statuses.r2 ?? 'ok') };
    const firebase = { checkHealth: jest.fn().mockResolvedValue(statuses.firebase ?? 'ok') };
    const openai = { checkHealth: jest.fn().mockResolvedValue(statuses.openai ?? 'disabled') };
    const gemini = { checkHealth: jest.fn().mockResolvedValue(statuses.gemini ?? 'ok') };
    return { service: new HealthService(prisma as never, redis as never, storage as never, firebase as never, openai as never, gemini as never), prisma, firebase };
  }

  it('returns only named dependency statuses', async () => {
    await expect(createService().service.checkDependencies()).resolves.toEqual({
      status: 'ok',
      dependencies: {
        database: { status: 'ok' }, redis: { status: 'ok' }, r2: { status: 'ok' },
        firebase: { status: 'ok' }, openai: { status: 'disabled' }, gemini: { status: 'ok' },
      },
    });
  });

  it('distinguishes each simulated external failure without details', async () => {
    const result = await createService({ r2: 'error', firebase: 'error', gemini: 'error' }).service.checkDependencies();
    expect(result.status).toBe('degraded');
    expect(result.dependencies).toMatchObject({ r2: { status: 'error' }, firebase: { status: 'error' }, gemini: { status: 'error' } });
    expect(JSON.stringify(result)).not.toMatch(/key|secret|credential|url/i);
  });

  it('reports database failure independently', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection detail'));
    expect((await service.checkDependencies()).dependencies.database.status).toBe('error');
  });

  it('bounds a stalled external dependency', async () => {
    jest.useFakeTimers();
    const { service, firebase } = createService();
    firebase.checkHealth.mockReturnValueOnce(new Promise(() => undefined));
    const result = service.checkDependencies();
    await jest.advanceTimersByTimeAsync(5_001);
    expect((await result).dependencies.firebase.status).toBe('error');
    jest.useRealTimers();
  });
});
