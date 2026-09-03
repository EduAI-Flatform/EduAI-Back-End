import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Body,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../../common/security/public.decorator';
import { RateLimit } from '../../../common/security/rate-limit.decorator';
import { OAuthCallbackDto } from '../dto/oauth-callback.dto';
import { OAuthExchangeDto } from '../dto/oauth-exchange.dto';
import { OAuthProfileDto } from '../dto/oauth-profile.dto';
import { OAuthStartDto } from '../dto/oauth-start.dto';
import { OAuthService } from './oauth.service';

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,64}$/;
const SOCIAL_PROVIDERS = new Set(['facebook', 'zalo']);

@ApiTags('Auth OAuth')
@Controller('auth/oauth')
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  @Get('providers')
  @Public()
  @RateLimit({
    identity: 'ip',
    limit: 60,
    name: 'auth-oauth-providers',
    windowSeconds: 15 * 60,
  })
  @ApiOkResponse({ description: 'Configured social OAuth providers.' })
  getProviders() {
    return this.oauthService.getProviderCapabilities();
  }

  @Get(':provider/start')
  @Public()
  @RateLimit({
    identity: 'ip',
    limit: 10,
    name: 'auth-oauth-start',
    windowSeconds: 15 * 60,
  })
  @ApiFoundResponse({ description: 'Redirects to the selected OAuth provider.' })
  @ApiBadRequestResponse({ description: 'Invalid OAuth start parameters.' })
  async start(
    @Param('provider') provider: string,
    @Query() input: OAuthStartDto,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.oauthService.start(provider, input);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(HttpStatus.FOUND, result.authorizationUrl);
  }

  @Get(':provider/callback')
  @Public()
  @RateLimit({
    identity: 'ip',
    limit: 20,
    name: 'auth-oauth-callback',
    windowSeconds: 15 * 60,
  })
  @ApiFoundResponse({ description: 'Redirects to the EduAI OAuth callback page.' })
  async callback(
    @Param('provider') provider: string,
    @Query() input: OAuthCallbackDto,
    @Res() response: Response,
  ): Promise<void> {
    if (!SOCIAL_PROVIDERS.has(provider)) {
      throw new HttpException('Unsupported OAuth provider', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.oauthService.handleCallback(provider, input);
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(HttpStatus.FOUND, result.redirectUrl);
    } catch (error) {
      const code = this.getSafeErrorCode(error);
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(
        HttpStatus.FOUND,
        this.oauthService.buildErrorRedirect(provider, code),
      );
    }
  }

  @Post('exchange')
  @Public()
  @RateLimit({
    identity: 'ip',
    limit: 10,
    name: 'auth-oauth-exchange',
    windowSeconds: 15 * 60,
  })
  @ApiOkResponse({ description: 'Exchanges a one-time OAuth ticket.' })
  @ApiBadRequestResponse({ description: 'Invalid OAuth ticket payload.' })
  @ApiUnauthorizedResponse({ description: 'OAuth ticket is invalid or expired.' })
  async exchange(@Body() input: OAuthExchangeDto) {
    return this.oauthService.exchange(input);
  }

  @Post('complete-profile')
  @Public()
  @RateLimit({
    identity: 'ip',
    limit: 10,
    name: 'auth-oauth-complete-profile',
    windowSeconds: 15 * 60,
  })
  @ApiOkResponse({ description: 'Completes the profile for an OAuth account.' })
  @ApiBadRequestResponse({ description: 'Invalid profile payload.' })
  @ApiUnauthorizedResponse({ description: 'OAuth profile ticket is invalid or expired.' })
  async completeProfile(@Body() input: OAuthProfileDto) {
    return this.oauthService.completeProfile(input);
  }

  private getSafeErrorCode(error: unknown): string {
    if (error instanceof HttpException) {
      const payload = error.getResponse();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'string' &&
        SAFE_ERROR_CODE.test(payload.error)
      ) {
        return payload.error;
      }
    }
    return 'OAUTH_CALLBACK_FAILED';
  }
}
