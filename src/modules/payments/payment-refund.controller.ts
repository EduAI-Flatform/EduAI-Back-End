import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateRefundDto, ListRefundsDto, RecordRefundDto, RejectRefundDto } from './dto/payment-refund.dto';
import { PaymentRefundService } from './payment-refund.service';

@ApiTags('Admin Payment Refunds')
@ApiBearerAuth()
@Controller('admin/commerce/refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.platform_admin)
export class PaymentRefundController {
  constructor(private readonly refunds: PaymentRefundService) {}
  @Get() list(@Query() query: ListRefundsDto) { return this.refunds.list(query); }
  @Post()
  @RateLimit({ identity: 'user', limit: 10, name: 'payment-refund-request', windowSeconds: 60 })
  create(@CurrentUser('id') actorId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: CreateRefundDto) {
    return this.refunds.create(actorId, key, input);
  }
  @Post(':refundId/record')
  @RateLimit({ identity: 'user', limit: 10, name: 'payment-refund-record', windowSeconds: 60 })
  record(@CurrentUser('id') actorId: string, @Param('refundId', new ParseUUIDPipe({ version: '4' })) refundId: string, @Body() input: RecordRefundDto) {
    return this.refunds.record(actorId, refundId, input);
  }
  @Post(':refundId/reject')
  @RateLimit({ identity: 'user', limit: 10, name: 'payment-refund-reject', windowSeconds: 60 })
  reject(@CurrentUser('id') actorId: string, @Param('refundId', new ParseUUIDPipe({ version: '4' })) refundId: string, @Body() input: RejectRefundDto) {
    return this.refunds.reject(actorId, refundId, input);
  }
}
