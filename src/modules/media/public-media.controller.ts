import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiFoundResponse, ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/security/public.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { PublicMediaService } from './public-media.service';

@ApiTags('Media')
@Controller('media/public')
@Public()
@RateLimit({ identity: 'ip', limit: 120, name: 'public-media', windowSeconds: 900 })
export class PublicMediaController {
  constructor(private readonly publicMedia: PublicMediaService) {}

  @Get(':token')
  @ApiFoundResponse({ description: 'Redirects to a short-lived R2 image URL.' })
  @ApiNotFoundResponse({ description: 'The public media token is invalid.' })
  async redirect(@Param('token') token: string, @Res() response: Response): Promise<void> {
    const url = await this.publicMedia.createRedirectUrl(token);
    response.setHeader('Cache-Control', 'public, max-age=240');
    response.redirect(302, url);
  }
}
