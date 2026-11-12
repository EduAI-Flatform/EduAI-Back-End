import { readActivityPointReadiness } from './activity-point.readiness';

describe('point activation readiness', () => {
  it('requires the reviewed migration, enabled guards and bounded runtime capabilities', async () => {
    const client = { $queryRaw: jest.fn().mockResolvedValue([{ migrationVerified: true, guardsVerified: true,
      schemaVerified: true, runtimeVerified: true }]) };
    expect(await readActivityPointReadiness(client as never)).toEqual({ ready: true, reason: null });
    for (const key of ['migrationVerified', 'guardsVerified', 'schemaVerified', 'runtimeVerified']) {
      client.$queryRaw.mockResolvedValue([{ migrationVerified: true, guardsVerified: true,
        schemaVerified: true, runtimeVerified: true, [key]: false }]);
      expect(await readActivityPointReadiness(client as never)).toEqual({ ready: false, reason: 'POINT_SCHEMA_NOT_VERIFIED' });
    }
  });
  it('fails closed without exposing database error details', async () => {
    const client = { $queryRaw: jest.fn().mockRejectedValue(new Error('private database failure')) };
    expect(await readActivityPointReadiness(client as never)).toEqual({ ready: false, reason: 'POINT_SCHEMA_NOT_VERIFIED' });
  });
});
