import { readCardServiceReadiness, CARD_QUOTA_SCHEMA_MIGRATION, CARD_QUOTA_SCHEMA_SHA256 } from './card-service-readiness';
describe('card service schema/runtime readiness', () => {
  const verified = { migrationVerified: true, guardsVerified: true, schemaVerified: true, runtimeVerified: true };
  it('accepts only the pinned schema with enabled guards and usable restricted runtime privileges', async () => {
    const client = { $queryRaw: jest.fn().mockResolvedValue([verified]) };
    expect(await readCardServiceReadiness(client as never)).toEqual({ ready: true, reason: null });
    const sql = client.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain(CARD_QUOTA_SCHEMA_MIGRATION);
    expect(sql.values).toContain(CARD_QUOTA_SCHEMA_SHA256);
    expect(sql.strings.join('')).toContain('membership_card_grant_context_key');
  });
  it.each(Object.keys(verified))('fails closed when %s is missing', async field => {
    const client = { $queryRaw: jest.fn().mockResolvedValue([{ ...verified, [field]: false }]) };
    expect(await readCardServiceReadiness(client as never)).toEqual({ ready: false, reason: 'CARD_SERVICE_SCHEMA_NOT_VERIFIED' });
  });
  it('does not disclose database errors or treat missing metadata as ready', async () => {
    expect(await readCardServiceReadiness({ $queryRaw: jest.fn().mockRejectedValue(new Error('private connection details')) } as never))
      .toEqual({ ready: false, reason: 'CARD_SERVICE_SCHEMA_NOT_VERIFIED' });
    expect((await readCardServiceReadiness({ $queryRaw: jest.fn().mockResolvedValue([]) } as never)).ready).toBe(false);
  });
});
