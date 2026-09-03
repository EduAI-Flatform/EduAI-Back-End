import { createHash } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import {
  OAuthProviderError,
  OAuthProviderService,
} from './oauth-provider.service';

function createConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  return {
    oauth: {
      facebook: {
        enabled: true,
        clientId: 'facebook-client-id',
        clientSecret: 'facebook-client-secret',
        redirectUri:
          'http://localhost:3000/api/v1/auth/oauth/facebook/callback',
        graphApiVersion: 'v26.0',
      },
      zalo: {
        enabled: true,
        appId: 'zalo-app-id',
        appSecret: 'zalo-app-secret',
        redirectUri: 'http://localhost:3000/api/v1/auth/oauth/zalo/callback',
        authVersion: 'v4',
        graphApiVersion: 'v2.0',
        scopes: ['id_name', 'picture'],
      },
      ...overrides,
    },
  } as AppConfigService;
}

describe('OAuthProviderService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports only configured and explicitly enabled providers', () => {
    const service = new OAuthProviderService(createConfig());

    expect(service.getCapabilities()).toEqual({
      google: true,
      facebook: true,
      zalo: true,
    });
    expect(
      new OAuthProviderService(
        createConfig({
          zalo: { ...createConfig().oauth.zalo, enabled: false },
        }),
      ).getCapabilities(),
    ).toEqual({ google: true, facebook: true, zalo: false });
  });

  it('keeps social capabilities disabled while retaining the existing Google flow', () => {
    const base = createConfig();
    const service = new OAuthProviderService(
      createConfig({
        facebook: { ...base.oauth.facebook, enabled: false },
        zalo: { ...base.oauth.zalo, enabled: false },
      }),
    );

    expect(service.getCapabilities()).toEqual({
      google: true,
      facebook: false,
      zalo: false,
    });
  });

  it('builds a Facebook authorization URL without exposing the client secret', () => {
    const service = new OAuthProviderService(createConfig());
    const url = new URL(
      service.buildAuthorizationUrl('facebook', 's'.repeat(43)),
    );

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v26.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('facebook-client-id');
    expect(url.searchParams.get('scope')).toBe('email,public_profile');
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.toString()).not.toContain('facebook-client-secret');
  });

  it('builds a Zalo authorization URL with the configured callback and state', () => {
    const service = new OAuthProviderService(createConfig());
    const url = new URL(
      service.buildAuthorizationUrl('zalo', 's'.repeat(43), 'v'.repeat(43)),
    );

    expect(url.origin).toBe('https://oauth.zaloapp.com');
    expect(url.pathname).toBe('/v4/permission');
    expect(url.searchParams.get('app_id')).toBe('zalo-app-id');
    expect(url.searchParams.get('redirect_uri')).toContain(
      '/api/v1/auth/oauth/zalo/callback',
    );
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update('v'.repeat(43), 'ascii')
        .digest('base64url'),
    );
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.toString()).not.toContain('zalo-app-secret');
  });

  it('exchanges Facebook code and normalizes only trusted-shaped profile fields', async () => {
    const service = new OAuthProviderService(createConfig());
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'facebook-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'facebook-user-id',
            name: 'Facebook Learner',
            email: 'Learner@Example.com',
            picture: { data: { url: 'https://cdn.example/avatar.png' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      service.resolveIdentity('facebook', 'authorization-code'),
    ).resolves.toEqual({
      providerUserId: 'facebook-user-id',
      email: 'learner@example.com',
      emailVerified: false,
      fullName: 'Facebook Learner',
      avatarUrl: 'https://cdn.example/avatar.png',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'graph.facebook.com/v26.0/oauth/access_token',
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(
      'facebook-access-token',
    );
  });

  it('uses Zalo Social API profile fields and never treats its email as verified', async () => {
    const service = new OAuthProviderService(createConfig());
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'zalo-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 0,
            message: 'Success',
            id: 'zalo-user-id',
            name: 'Zalo Learner',
            picture: { data: { url: 'https://cdn.example/zalo.png' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(service.resolveIdentity('zalo', 'zalo-code', 'v'.repeat(43))).resolves.toEqual({
      providerUserId: 'zalo-user-id',
      emailVerified: false,
      fullName: 'Zalo Learner',
      avatarUrl: 'https://cdn.example/zalo.png',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(tokenRequest.method).toBe('POST');
    expect(new Headers(tokenRequest.headers).get('secret_key')).toBe(
      'zalo-app-secret',
    );
    expect(String(tokenRequest.body)).toContain(
      'code_verifier=' + 'v'.repeat(43),
    );
    const profileUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(profileUrl.pathname).toBe('/v2.0/me');
    expect(profileUrl.searchParams.get('fields')).toBe('id,name,picture');
    expect(profileUrl.searchParams.get('access_token')).toBeNull();
    expect(
      new Headers(fetchMock.mock.calls[1][1] && (fetchMock.mock.calls[1][1] as RequestInit).headers).get(
        'access_token',
      ),
    ).toBe('zalo-access-token');
  });

  it('rejects Zalo token exchange without the state-bound PKCE verifier', async () => {
    const service = new OAuthProviderService(createConfig());
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await expect(service.resolveIdentity('zalo', 'zalo-code')).rejects.toEqual(
      expect.objectContaining({ code: 'OAUTH_PROVIDER_RESPONSE_INVALID' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed provider responses and provider failures without leaking details', async () => {
    const service = new OAuthProviderService(createConfig());
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'secret provider detail' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(service.resolveIdentity('facebook', 'code')).rejects.toEqual(
      expect.objectContaining({ code: 'OAUTH_PROVIDER_REQUEST_FAILED' }),
    );
    await expect(service.resolveIdentity('facebook', 'code')).rejects.not.toThrow(
      'secret provider detail',
    );
    expect(new OAuthProviderError('facebook', 'profile')).toBeInstanceOf(Error);
  });
});
