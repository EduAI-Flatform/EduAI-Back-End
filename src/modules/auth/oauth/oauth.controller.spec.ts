import { BadRequestException } from '@nestjs/common';
import { OAuthController } from './oauth.controller';

function createController() {
  const oauthService = {
    getProviderCapabilities: jest
      .fn()
      .mockReturnValue({ google: true, facebook: true, zalo: false }),
    start: jest.fn().mockResolvedValue({ authorizationUrl: 'https://provider.example/start' }),
    handleCallback: jest.fn().mockResolvedValue({
      redirectUrl: 'https://eduai.example/auth/callback?ticket=ticket',
    }),
    buildErrorRedirect: jest.fn().mockReturnValue(
      'https://eduai.example/auth/callback?provider=facebook&error=OAUTH_STATE_INVALID',
    ),
    exchange: jest.fn().mockResolvedValue({ kind: 'session' }),
    completeProfile: jest.fn().mockResolvedValue({ kind: 'session' }),
  };
  const logger = { error: jest.fn() };

  return {
    controller: new OAuthController(oauthService as never, logger as never),
    oauthService,
    logger,
    response: {
      redirect: jest.fn(),
      setHeader: jest.fn(),
    },
  };
}

describe('OAuthController', () => {
  it('exposes configured provider capabilities', () => {
    const { controller } = createController();

    expect(controller.getProviders()).toEqual({
      google: true,
      facebook: true,
      zalo: false,
    });
  });

  it('redirects the browser to the provider start URL without returning a body', async () => {
    const { controller, oauthService, response } = createController();

    await controller.start(
      'facebook',
      { mode: 'login' },
      response as never,
    );

    expect(oauthService.start).toHaveBeenCalledWith('facebook', { mode: 'login' });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://provider.example/start',
    );
  });

  it('redirects successful callbacks to the fixed frontend callback route', async () => {
    const { controller, oauthService, response } = createController();

    await controller.callback(
      'facebook',
      { code: 'provider-code', state: 's'.repeat(43) },
      response as never,
    );

    expect(oauthService.handleCallback).toHaveBeenCalledWith('facebook', {
      code: 'provider-code',
      state: 's'.repeat(43),
    });
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://eduai.example/auth/callback?ticket=ticket',
    );
  });

  it('sanitizes callback failures into a frontend error code', async () => {
    const { controller, oauthService, response } = createController();
    oauthService.handleCallback.mockRejectedValueOnce(
      new BadRequestException({ error: 'OAUTH_STATE_INVALID', message: 'hidden detail' }),
    );

    await controller.callback(
      'facebook',
      { state: 's'.repeat(43) },
      response as never,
    );

    expect(oauthService.buildErrorRedirect).toHaveBeenCalledWith(
      'facebook',
      'OAUTH_STATE_INVALID',
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://eduai.example/auth/callback?provider=facebook&error=OAUTH_STATE_INVALID',
    );
  });

  it('does not expose arbitrary callback exception details', async () => {
    const { controller, oauthService, response, logger } = createController();
    const failure = Object.assign(new Error('provider secret detail'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });
    oauthService.handleCallback.mockRejectedValueOnce(failure);

    await controller.callback(
      'zalo',
      { state: 's'.repeat(43) },
      response as never,
      { correlationId: 'request-12345678' } as never,
    );

    expect(oauthService.buildErrorRedirect).toHaveBeenCalledWith(
      'zalo',
      'OAUTH_CALLBACK_FAILED',
    );
    expect(logger.error).toHaveBeenCalledWith(
      'OAuth callback failed',
      'OAuthCallback',
      expect.objectContaining({
        correlationId: 'request-12345678',
        exceptionClass: 'Error',
        prismaCode: 'P2002',
        provider: 'zalo',
        safeOAuthCode: 'OAUTH_CALLBACK_FAILED',
        stage: 'callback',
        targetField: 'email',
      }),
    );
    const diagnosticLog = JSON.stringify(logger.error.mock.calls[0]);
    expect(diagnosticLog).not.toContain('provider secret detail');
    expect(diagnosticLog).not.toContain('authorization-code');
    expect(diagnosticLog).not.toContain('secret');
  });
});
