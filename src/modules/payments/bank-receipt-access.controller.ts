import { Body, Controller, Get, Header, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength, Matches } from 'class-validator';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BankReceiptAccessService } from './bank-receipt-access.service';

export class ReceiptAccessActionDto {
  @IsString() @MinLength(8) @MaxLength(300) @Matches(/\S/) reason!: string;
  @IsInt() @Min(1) expectedGeneration!: number;
}

@ApiTags('Receipt Access') @ApiBearerAuth()
@Controller('payments/receipts') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.student)
export class BankReceiptAccessController {
  constructor(private readonly access: BankReceiptAccessService) {}
  @Get(':receiptId/access') @Header('Cache-Control', 'no-store')
  describe(@CurrentUser('id') buyerId: string, @Param('receiptId', new ParseUUIDPipe({ version: '4' })) receiptId: string) {
    return this.access.describeClaim(buyerId, receiptId);
  }
}

@ApiTags('Admin Receipt Access') @ApiBearerAuth()
@Controller('admin/commerce/receipt-claims') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
export class BankReceiptAccessAdminController {
  constructor(private readonly access: BankReceiptAccessService) {}
  @Get(':receiptId/access') @Header('Cache-Control', 'no-store')
  describe(@CurrentUser('id') actorId: string, @Param('receiptId', new ParseUUIDPipe({ version: '4' })) receiptId: string) {
    return this.access.describeClaimAdmin(actorId, receiptId);
  }
  @Post(':receiptId/revoke') @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 10, name: 'receipt-access-revoke', windowSeconds: 60 })
  revoke(@CurrentUser('id') actorId: string, @Param('receiptId', new ParseUUIDPipe({ version: '4' })) receiptId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: ReceiptAccessActionDto) {
    return this.access.revoke(actorId, receiptId, key, body);
  }
  @Post(':receiptId/restore') @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 10, name: 'receipt-access-restore', windowSeconds: 60 })
  restore(@CurrentUser('id') actorId: string, @Param('receiptId', new ParseUUIDPipe({ version: '4' })) receiptId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: ReceiptAccessActionDto) {
    return this.access.restore(actorId, receiptId, key, body);
  }
}