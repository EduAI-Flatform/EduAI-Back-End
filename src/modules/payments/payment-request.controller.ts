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
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PaymentRequestResponseDto } from './dto/payment-request-response.dto';
import { PaymentRequestService } from './payment-request.service';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.student)
export class PaymentRequestController {
  constructor(private readonly payments: PaymentRequestService) {}

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
}
