import { validatePlatformSettings } from './platform-settings.validation';

const partner = { name: 'Synthetic School', logoUrl: '/gds-logo.png', url: 'https://example.test', category: 'school' };
describe('partner catalog connection metadata', () => {
  it.each(['unconfigured', 'preparing', 'testing', 'connected', 'suspended'])('accepts declared connection status %s without enabling intake', connectionStatus => {
    const content = { enabled: false, items: [{ ...partner, connectionStatus }] };
    expect(validatePlatformSettings('partners', content)).toBe('partners');
    expect(content.enabled).toBe(false);
  });
  it('retains historical content without adding a status or altering its fields', () => {
    const content = { enabled: false, items: [{ ...partner }] };
    const before = JSON.stringify(content);
    expect(validatePlatformSettings('partners', content)).toBe('partners');
    expect(JSON.stringify(content)).toBe(before);
  });
  it.each(['accepted', 'live', '', null, false, 1, { enabled: true }])('rejects unsupported connection status %j', connectionStatus => {
    expect(() => validatePlatformSettings('partners', { enabled: true, items: [{ ...partner, connectionStatus }] })).toThrow();
  });
  it('continues rejecting unsafe URLs and integration credential fields', () => {
    expect(() => validatePlatformSettings('partners', { enabled: true, items: [{ ...partner, connectionStatus: 'testing', apiKey: 'synthetic' }] })).toThrow();
    expect(() => validatePlatformSettings('partners', { enabled: true, items: [{ ...partner, connectionStatus: 'connected', url: 'javascript:alert(1)' }] })).toThrow();
  });
});
