import { GdsBankLookupProvider } from './gds-bank-provider';
import { validateEnv } from '../../config/env.validation';

const config = { bankVerification: { enabled: true, clientId: 'test-client', apiKey: 'test-key', supportedBins: ['970423'] } };
describe('VietQR beneficiary boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it('requires independent credentials and an approved bank list before enabling', () => {
    const base = { DATABASE_URL: 'postgresql://localhost/test', JWT_ACCESS_SECRET: 'test-access', JWT_REFRESH_SECRET: 'test-refresh' };
    expect(validateEnv(base)).toHaveProperty('GDS_BANK_VERIFICATION_ENABLED', false);
    expect(() => validateEnv({ ...base, GDS_BANK_VERIFICATION_ENABLED: 'true' })).toThrow('GDS_VIETQR');
    expect(() => validateEnv({ ...base, GDS_VIETQR_SUPPORTED_BINS: 'bad' })).toThrow('GDS_VIETQR_SUPPORTED_BINS');
  });
  it('preserves leading zeroes and uses separate VietQR credentials', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: '00', data: { accountName: 'NGUYEN VAN A' } })));
    await expect(new GdsBankLookupProvider(config as never).lookup('970423', '0012345678')).resolves.toEqual({ accountHolder: 'NGUYEN VAN A', provider: 'vietqr' });
    expect(fetcher).toHaveBeenCalledWith('https://api.vietqr.io/v2/lookup', expect.objectContaining({ redirect: 'error', body: JSON.stringify({ bin: '970423', accountNumber: '0012345678' }), headers: expect.objectContaining({ 'x-client-id': 'test-client', 'x-api-key': 'test-key' }) }));
  });
  it('never sends an account to an unsupported or disabled provider', async () => {
    const fetcher = jest.spyOn(global, 'fetch');
    await expect(new GdsBankLookupProvider(config as never).lookup('970999', '0012345678')).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])('redacts upstream HTTP %s', async (status) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('private upstream account data', { status }));
    await expect(new GdsBankLookupProvider(config as never).lookup('970423', '0012345678')).rejects.toMatchObject({ status: 503 });
  });
  it('redacts upstream timeout failures without retrying beneficiary lookup', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Timeout including private upstream request'));
    await expect(new GdsBankLookupProvider(config as never).lookup('970423', '0012345678')).rejects.toMatchObject({ status: 503, message: 'Dịch vụ xác minh ngân hàng tạm thời không khả dụng.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ code: '01' }, { code: '00', data: { accountName: 'A' } }, { code: '00', data: { accountName: 'NAME', accountNumber: '99999999' } }])('rejects invalid or mismatched lookup responses', async (body) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new GdsBankLookupProvider(config as never).lookup('970423', '0012345678')).rejects.toMatchObject({ status: 400 });
  });
});
