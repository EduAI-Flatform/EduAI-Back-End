import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import {
  OAuthIdentity,
  OAuthProviderCapabilities,
  SocialOAuthProvider,
} from './oauth.types';

type OAuthProviderStage = 'authorization' | 'token_exchange' | 'profile';

export class OAuthProviderError extends Error {
  readonly code:
    | 'OAUTH_PROVIDER_UNAVAILABLE'
    | 'OAUTH_PROVIDER_REQUEST_FAILED'
    | 'OAUTH_PROVIDER_RESPONSE_INVALID';

  constructor(
    public readonly provider: SocialOAuthProvider,
    public readonly stage: OAuthProviderStage,
    code: OAuthProviderError['code'] = 'OAUTH_PROVIDER_REQUEST_FAILED',
  ) {
    super('OAuth provider request failed');
    this.name = 'OAuthProviderError';
    this.code = code;
  }
}

@Injectable()
export class OAuthProviderService {
  constructor(private readonly appConfig: AppConfigService) {}

  getCapabilities(): OAuthProviderCapabilities {
    const { facebook, zalo } = this.appConfig.oauth;
    return {
      google: true,
      facebook: this.isFacebookConfigured() && facebook.enabled,
      zalo: this.isZaloConfigured() && zalo.enabled,
    };
  }

  buildAuthorizationUrl(
    provider: SocialOAuthProvider,
    state: string,
    codeVerifier?: string,
  ): string {
    this.assertState(provider, state);

    if (!this.getCapabilities()[provider]) {
      throw new OAuthProviderError(
        provider,
        'authorization',
        'OAUTH_PROVIDER_UNAVAILABLE',
      );
    }

    if (provider === 'facebook') {
      const config = this.appConfig.oauth.facebook;
      const url = new URL(
        `https://www.facebook.com/${config.graphApiVersion}/dialog/oauth`,
      );
      url.searchParams.set('client_id', config.clientId as string);
      url.searchParams.set('redirect_uri', config.redirectUri as string);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'email,public_profile');
      return url.toString();
    }

    const config = this.appConfig.oauth.zalo;
    const url = new URL(
      `https://oauth.zaloapp.com/${config.authVersion}/permission`,
    );
    if (!this.isCodeVerifierValid(codeVerifier)) {
      throw new OAuthProviderError(
        'zalo',
        'authorization',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }
    url.searchParams.set('app_id', config.appId as string);
    url.searchParams.set('redirect_uri', config.redirectUri as string);
    url.searchParams.set('code_challenge', this.createCodeChallenge(codeVerifier));
    url.searchParams.set('state', state);
    // Zalo Social permissions are selected in the developer console. Keep the
    // request on the minimum configured profile set and do not request email.
    return url.toString();
  }

  async resolveIdentity(
    provider: SocialOAuthProvider,
    code: string,
    codeVerifier?: string,
  ): Promise<OAuthIdentity> {
    if (!this.getCapabilities()[provider] || !this.isCodeValid(code)) {
      throw new OAuthProviderError(
        provider,
        'token_exchange',
        'OAUTH_PROVIDER_UNAVAILABLE',
      );
    }

    return provider === 'facebook'
      ? this.resolveFacebookIdentity(code)
      : this.resolveZaloIdentity(code, codeVerifier);
  }

  private async resolveFacebookIdentity(code: string): Promise<OAuthIdentity> {
    const config = this.appConfig.oauth.facebook;
    const tokenUrl = new URL(
      `https://graph.facebook.com/${config.graphApiVersion}/oauth/access_token`,
    );
    tokenUrl.searchParams.set('client_id', config.clientId as string);
    tokenUrl.searchParams.set('client_secret', config.clientSecret as string);
    tokenUrl.searchParams.set('redirect_uri', config.redirectUri as string);
    tokenUrl.searchParams.set('code', code);
    const token = await this.requestJson(
      'facebook',
      'token_exchange',
      tokenUrl.toString(),
    );
    const accessToken = this.readString(token.access_token, 4096);
    if (!accessToken) {
      throw new OAuthProviderError(
        'facebook',
        'token_exchange',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }

    const profileUrl = new URL(
      `https://graph.facebook.com/${config.graphApiVersion}/me`,
    );
    profileUrl.searchParams.set('fields', 'id,name,email,picture.type(large)');
    profileUrl.searchParams.set('access_token', accessToken);
    const profile = await this.requestJson(
      'facebook',
      'profile',
      profileUrl.toString(),
    );
    return this.normalizeIdentity('facebook', profile, true);
  }

  private async resolveZaloIdentity(
    code: string,
    codeVerifier?: string,
  ): Promise<OAuthIdentity> {
    const config = this.appConfig.oauth.zalo;
    if (!this.isCodeVerifierValid(codeVerifier)) {
      throw new OAuthProviderError(
        'zalo',
        'token_exchange',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }
    const tokenUrl = `https://oauth.zaloapp.com/${config.authVersion}/access_token`;
    const token = await this.requestJson('zalo', 'token_exchange', tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        secret_key: config.appSecret as string,
      },
      body: new URLSearchParams({
        app_id: config.appId as string,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const accessToken = this.readString(token.access_token, 4096);
    if (!accessToken) {
      throw new OAuthProviderError(
        'zalo',
        'token_exchange',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }

    const profileUrl = new URL(
      `https://graph.zalo.me/${config.graphApiVersion}/me`,
    );
    profileUrl.searchParams.set('fields', 'id,name,picture');
    const profile = await this.requestJson(
      'zalo',
      'profile',
      profileUrl.toString(),
      { headers: { access_token: accessToken } },
    );
    return this.normalizeIdentity('zalo', profile, false);
  }

  private async requestJson(
    provider: SocialOAuthProvider,
    stage: OAuthProviderStage,
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.appConfig.oauth.httpTimeoutMs,
    );

    try {
      const response = await globalThis.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
        throw new OAuthProviderError(provider, stage);
      }
      const body = await response.text();
      if (!response.ok || body.length > 64 * 1024) {
        throw new OAuthProviderError(provider, stage);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new OAuthProviderError(
          provider,
          stage,
          'OAUTH_PROVIDER_RESPONSE_INVALID',
        );
      }
      if (!this.isRecord(parsed)) {
        throw new OAuthProviderError(
          provider,
          stage,
          'OAUTH_PROVIDER_RESPONSE_INVALID',
        );
      }
      if (
        'error' in parsed &&
        !(provider === 'zalo' && (parsed.error === 0 || parsed.error === '0'))
      ) {
        throw new OAuthProviderError(provider, stage);
      }
      return parsed;
    } catch (error) {
      if (error instanceof OAuthProviderError) throw error;
      throw new OAuthProviderError(provider, stage);
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeIdentity(
    provider: SocialOAuthProvider,
    profile: Record<string, unknown>,
    allowEmail: boolean,
  ): OAuthIdentity {
    const providerUserId = this.readString(profile.id, 255);
    if (!providerUserId) {
      throw new OAuthProviderError(
        provider,
        'profile',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }

    const name = this.readString(profile.name, 160);
    const email = allowEmail ? this.normalizeEmail(profile.email) : undefined;
    const picture = this.isRecord(profile.picture)
      ? this.isRecord(profile.picture.data)
        ? profile.picture.data.url
        : profile.picture.url
      : profile.picture;

    return {
      providerUserId,
      email,
      emailVerified: false,
      fullName: name ?? `Người dùng ${provider === 'facebook' ? 'Facebook' : 'Zalo'}`,
      avatarUrl: this.normalizeAvatar(picture),
    };
  }

  private normalizeEmail(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 320) return undefined;
    const email = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  }

  private normalizeAvatar(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:'
        ? url.toString()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private readString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
  }

  private isFacebookConfigured(): boolean {
    const config = this.appConfig.oauth.facebook;
    return Boolean(
      config.clientId &&
        config.clientSecret &&
        config.redirectUri &&
        config.graphApiVersion,
    );
  }

  private isZaloConfigured(): boolean {
    const config = this.appConfig.oauth.zalo;
    return Boolean(
      config.appId &&
        config.appSecret &&
        config.redirectUri &&
        config.authVersion &&
        config.graphApiVersion,
    );
  }

  private assertState(provider: SocialOAuthProvider, state: string): void {
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(state)) {
      throw new OAuthProviderError(
        provider,
        'authorization',
        'OAUTH_PROVIDER_RESPONSE_INVALID',
      );
    }
  }

  private isCodeValid(code: string): boolean {
    return typeof code === 'string' && code.trim().length > 0 && code.length <= 4096;
  }

  private isCodeVerifierValid(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[A-Za-z0-9._~-]{43,128}$/.test(value)
    );
  }

  private createCodeChallenge(codeVerifier: string): string {
    return createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
