import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PaymentRequestResponseDto } from './dto/payment-request-response.dto';
import { PaymentLifecycleResponseDto } from './dto/payment-lifecycle.dto';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentRequestService } from './payment-request.service';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class PaymentRequestController {
  constructor(
    private readonly payments: PaymentRequestService,
    private readonly lifecycle: PaymentLifecycleService,
  ) {}

  @Post(':orderId/request')
  @ApiCreatedResponse({ type: PaymentRequestResponseDto })
  create(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PaymentRequestResponseDto> {
    return this.payments.create(learnerId, orderId, idempotencyKey);
  }

  @Get(':orderId/request')
  @ApiOkResponse({ type: PaymentRequestResponseDto })
  status(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<PaymentRequestResponseDto> {
    return this.payments.status(learnerId, orderId);
  }

  @Post(':orderId/cancel')
  @RateLimit({ identity: 'user', limit: 6, name: 'payment-cancel', windowSeconds: 60 })
  @ApiOkResponse({ type: PaymentLifecycleResponseDto })
  cancel(
    @CurrentUser('id') learnerId: string,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PaymentLifecycleResponseDto> {
    return this.lifecycle.cancel(learnerId, orderId, idempotencyKey);
  }
}
