import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/security/public.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AffiliateService } from './affiliate.service';
import { AffiliateAttributionDto, AffiliateIdentityDto, AffiliateListQuery, AffiliateReconcileDto, AffiliateVisitDto } from './affiliate.dto';
import { affiliateWorkbook } from './affiliate-workbook';
@ApiTags('Affiliate') @ApiBearerAuth() @Controller('affiliate') @UseGuards(JwtAuthGuard)
@RateLimit({ identity: 'user', limit: 60, name: 'affiliate-owner', windowSeconds: 60 })
export class AffiliateController {
  constructor(private readonly service: AffiliateService) {}
  @Get('me') state(@CurrentUser('id') ownerId: string) { return this.service.state(ownerId); }
  @Post('identities') @RateLimit({ identity: 'user', limit: 5, name: 'affiliate-identity', windowSeconds: 3600 })
  identity(@CurrentUser() user: AuthenticatedUser, @Body() body: AffiliateIdentityDto) { return this.service.identity(user.id, body.kind, user.roles); }
  @Public() @Post('visits') @RateLimit({ identity: 'ip', limit: 30, name: 'affiliate-visits', windowSeconds: 3600 })
  visit(@Body() body: AffiliateVisitDto) { return this.service.visit(body.code); }
  @Post('attributions') @RateLimit({ identity: 'user', limit: 20, name: 'affiliate-attribution', windowSeconds: 3600 })
  attribute(@CurrentUser('id') buyerId: string, @Body() body: AffiliateAttributionDto) { return this.service.attribute(buyerId, body.orderId, body.visitToken); }
  @Post('reconcile') @RateLimit({ identity: 'user', limit: 10, name: 'affiliate-reconcile', windowSeconds: 3600 })
  reconcile(@CurrentUser('id') ownerId: string, @Body() body: AffiliateReconcileDto) { return this.service.reconcile(ownerId, body.after); }
  @Get('performance') list(@CurrentUser('id') ownerId: string, @Query() query: AffiliateListQuery) { return this.service.list(ownerId, query); }
  @Get('performance/export') @RateLimit({ identity: 'user', limit: 5, name: 'affiliate-export', windowSeconds: 60 })
  async export(@CurrentUser('id') ownerId: string, @Query() query: AffiliateListQuery) {
    // Export is deliberately bounded to the selected page and filters.
    const result = await this.service.list(ownerId, query);
    return { filename: 'gds-affiliate-page-' + result.page + '.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dataBase64: affiliateWorkbook(result.items).toString('base64'), total: result.total, exported: result.items.length };
  }
}
