import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { Public } from '../../common/security/public.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GdsBankCatalogueService } from './gds-bank-catalogue.service';
import { GdsAccountVerificationService } from './gds-account-verification.service';
import { GdsWithdrawalService } from './gds-withdrawal.service';
import { GdsVerifyAccountDto } from './dto/gds-withdrawal.dto';

@ApiTags('GDS Bank Verification') @ApiBearerAuth()
@Controller('wallet/gds') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.student, RoleName.instructor)
export class GdsBankController {
  constructor(private readonly banks: GdsBankCatalogueService, private readonly accounts: GdsAccountVerificationService, private readonly withdrawals: GdsWithdrawalService) {}
  @Get('banks') @RateLimit({ identity: 'user', limit: 30, name: 'gds-banks-list', windowSeconds: 60 })
  async list() { return this.banks.list((await this.withdrawals.settings()).accountVerificationRequired); }
  @Post('account-verifications') @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 6, name: 'gds-bank-account-verify', windowSeconds: 60 })
  verify(@CurrentUser('id') ownerId: string, @Body() input: GdsVerifyAccountDto) { return this.accounts.verify(ownerId, input.bankCode, input.accountNumber); }
}

@ApiTags('Admin GDS Bank Verification') @ApiBearerAuth()
@Controller('admin/wallet/gds') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
export class GdsBankAdminController {
  constructor(private readonly banks: GdsBankCatalogueService, private readonly accounts: GdsAccountVerificationService, private readonly withdrawals: GdsWithdrawalService) {}
  @Get('banks') @RateLimit({ identity: 'user', limit: 30, name: 'gds-admin-banks-list', windowSeconds: 60 })
  async list() { return this.banks.list((await this.withdrawals.settings()).accountVerificationRequired); }
  @Post('withdrawals/:id/verify-account') @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 6, name: 'gds-admin-bank-account-verify', windowSeconds: 60 })
  verify(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.accounts.verifyTransfer(actorId, id); }
  @Get('withdrawals/:id/qr') @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 20, name: 'gds-withdrawal-qr', windowSeconds: 60 })
  qr(@CurrentUser('id') actorId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.accounts.qr(actorId, id); }
}

/** Public image catalogue only; no account numbers, secrets or user-provided URLs. */
@Controller('wallet/gds/banks')
export class GdsBankLogoController {
  constructor(private readonly banks: GdsBankCatalogueService) {}
  @Get(':code/logo') @Public()
  @RateLimit({ identity: 'ip', limit: 300, name: 'gds-bank-logos', windowSeconds: 60 })
  async logo(@Param('code') code: string, @Res() response: Response) {
    const data = await this.banks.logo(code);
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(data);
  }
}
