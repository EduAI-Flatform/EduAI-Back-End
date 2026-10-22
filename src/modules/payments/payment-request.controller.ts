import {
  Controller,
  Body,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  ListPendingPaymentQueryDto,
  PaymentRequestPageResponseDto,
  PaymentRequestResponseDto,
} from './dto/payment-request-response.dto';
import { PaymentLifecycleResponseDto } from './dto/payment-lifecycle.dto';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentRequestService } from './payment-request.service';
import { BankTransferService } from './bank-transfer.service';
import { CreatePaymentMethodDto } from './dto/bank-transfer.dto';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class PaymentRequestController {
  constructor(
    private readonly payments: PaymentRequestService,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly bank: BankTransferService,
  ) {}

  @Get('pending')
  @ApiOkResponse({ type: PaymentRequestPageResponseDto })
  async pending(
    @CurrentUser('id') learnerId: string,
    @Query() query: ListPendingPaymentQueryDto,
  ): Promise<PaymentRequestPageResponseDto> {
    const page = await this.payments.pending(learnerId, query);
    return { ...page, items: await Promise.all(page.items.map((item) => item.payment?.provider === 'bank_transfer'
      ? this.bank.status(learnerId, item.orderId) : item)) };
  }

  @Post(':orderId/request')
  @ApiCreatedResponse({ type: PaymentRequestResponseDto })
  create(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Body() input: CreatePaymentMethodDto = {},
  ): Promise<PaymentRequestResponseDto> {
    return this.payments.create(learnerId, orderId, idempotencyKey, request.ip, input.provider);
  }

  @Get(':orderId/request')
  @ApiOkResponse({ type: PaymentRequestResponseDto })
  async status(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<PaymentRequestResponseDto> {
    if (await this.bank.ownsBankOrder(learnerId, orderId)) return this.bank.status(learnerId, orderId);
    return this.payments.status(learnerId, orderId);
  }

  @Post(':orderId/cancel')
  @RateLimit({ identity: 'user', limit: 6, name: 'payment-cancel', windowSeconds: 60 })
  @ApiOkResponse({ type: PaymentLifecycleResponseDto })
  async cancel(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PaymentLifecycleResponseDto> {
    if (await this.bank.ownsBankOrder(learnerId, orderId)) return this.bank.cancel(learnerId, orderId, idempotencyKey);
    return this.lifecycle.cancel(learnerId, orderId, idempotencyKey);
  }
}
