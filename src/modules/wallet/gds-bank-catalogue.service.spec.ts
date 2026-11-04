import { GdsBankCatalogueService } from './gds-bank-catalogue.service';

const bank = { code: 'TPB', bin: '970423', shortName: 'TPBank', name: 'Ngân hàng Tiên Phong', logo: 'https://cdn.vietqr.io/img/TPB.png', lookupSupported: 1, transferSupported: 1 };
const config = { bankVerification: { enabled: false, supportedBins: [] } };
describe('GDS official bank catalogue', () => {
  afterEach(() => jest.restoreAllMocks());
  it('serves the complete snapshot during a cold-start upstream outage', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await new GdsBankCatalogueService(config as never).list(false);
    expect(result.banks.length).toBeGreaterThan(50);
    expect(result).toMatchObject({ stale: true, verificationAvailable: false });
    expect(result.banks.every((item) => !item.verificationSupported && item.logoUrl.startsWith('/api/v1/wallet/gds/banks/'))).toBe(true);
  });
  it('caches a validated response for 24h and resolves canonical code or BIN', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: '00', data: [bank] })));
    const service = new GdsBankCatalogueService(config as never);
    expect(await service.get('970423')).toMatchObject({ code: 'TPB', lookupSupported: true });
    expect(await service.get('tpb')).toMatchObject({ code: 'TPB' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign logo origins without making a second network call', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: '00', data: [{ ...bank, logo: 'https://private.example/img/TPB.png' }] })));
    const service = new GdsBankCatalogueService(config as never);
    await service.list(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await service.get('TPB')).toMatchObject({ code: 'TPB' });
  });
  it('retains the last valid catalogue after expiry and an invalid refresh', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000000000);
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ code: '00', data: [bank] }))).mockResolvedValueOnce(new Response(JSON.stringify({ code: '00', data: [bank, bank] })));
    const service = new GdsBankCatalogueService(config as never);
    await service.list(false);
    clock.mockReturnValue(1000000000 + 25 * 60 * 60 * 1000);
    expect(await service.list(false)).toMatchObject({ stale: true, banks: [{ code: 'TPB' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('requires provider credentials, approved BIN and bank support together', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: '00', data: [bank] })));
    const service = new GdsBankCatalogueService({ bankVerification: { enabled: true, clientId: 'client', apiKey: 'key', supportedBins: ['970423'] } } as never);
    expect(await service.list(true)).toMatchObject({ verificationRequired: true, verificationAvailable: true, banks: [{ verificationSupported: true }] });
  });
  it('rejects SVG disguised as PNG and oversized images', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ code: '00', data: [bank] })))
      .mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(256 * 1024 + 1), { headers: { 'content-type': 'image/png' } }));
    const service = new GdsBankCatalogueService(config as never);
    await expect(service.logo('TPB')).rejects.toMatchObject({ status: 503 });
    await expect(service.logo('TPB')).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenLastCalledWith('https://cdn.vietqr.io/img/TPB.png', expect.objectContaining({ redirect: 'error' }));
  });
});
