import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { BankTransferService } from './bank-transfer.service';
import { BankApprovalDto, BankStatementDto, BankSupportDto } from './dto/bank-transfer.dto';
import { ListPendingPaymentQueryDto } from './dto/payment-request-response.dto';
import { PAYMENT_PROVIDER_REGISTRY, PaymentProviderRegistry } from './payment-provider.registry';

@ApiTags('Payments') @ApiBearerAuth()
@Controller('payments') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.student)
export class BankTransferController {
  constructor(private readonly bank: BankTransferService,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly registry: PaymentProviderRegistry) {}
  @Get('methods')
  methods() {
    return { methods: [...(['payos', 'vnpay'] as const).filter((provider) => this.registry.isEnabled(provider)),
      ...(this.bank.enabled() ? ['bank_transfer'] : [])] };
  }
  @Post('orders/:orderId/bank-transfer/support')
  @RateLimit({ identity: 'user', limit: 6, name: 'bank-support', windowSeconds: 60 })
  support(@CurrentUser('id') actorId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: BankSupportDto) {
    return this.bank.support(actorId, orderId, key, input.reason);
  }
}

@ApiTags('Admin Bank Reconciliation') @ApiBearerAuth()
@Controller('admin/commerce/bank-transfers') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(RoleName.platform_admin)
export class BankTransferAdminController {
  constructor(private readonly bank: BankTransferService) {}
  @Get() list(@CurrentUser('id') actorId: string, @Query() query: ListPendingPaymentQueryDto) {
    return this.bank.list(actorId, query);
  }
  @Get(':requestId') detail(@CurrentUser('id') actorId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string) { return this.bank.detail(actorId, requestId); }
  @Post(':requestId/statements')
  @RateLimit({ identity: 'user', limit: 10, name: 'bank-statement', windowSeconds: 60 })
  record(@CurrentUser('id') actorId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: BankStatementDto) {
    return this.bank.recordStatement(actorId, requestId, key, input);
  }
  @Post('evidence/:evidenceId/approvals')
  @RateLimit({ identity: 'user', limit: 10, name: 'bank-approve', windowSeconds: 60 })
  approve(@CurrentUser('id') actorId: string,
    @Param('evidenceId', new ParseUUIDPipe({ version: '4' })) evidenceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: BankApprovalDto) { return this.bank.approve(actorId, evidenceId, key, input); }
}
