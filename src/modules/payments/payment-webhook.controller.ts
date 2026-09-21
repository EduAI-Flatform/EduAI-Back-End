import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/security/public.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { PaymentWebhookResponseDto } from './dto/payment-webhook-response.dto';
import { PaymentWebhookService } from './payment-webhook.service';
import { isWellFormedVnPayQueryEncoding, VnPayIpnService } from './vnpay-ipn.service';

const MAX_WEBHOOK_BYTES = 32 * 1024;

@ApiTags('Payments')
@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(
    private readonly webhooks: PaymentWebhookService,
    private readonly vnpayIpn: VnPayIpnService,
  ) {}

  @Post('payos')
  @Public()
  @RateLimit({ identity: 'ip', limit: 120, name: 'payos-webhook', windowSeconds: 15 * 60 })
  @HttpCode(200)
  @ApiOkResponse({ type: PaymentWebhookResponseDto })
  receive(
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentWebhookResponseDto> {
    if (!contentType?.toLowerCase().startsWith('application/json')) {
      throw new UnsupportedMediaTypeException({
        error: 'WEBHOOK_JSON_REQUIRED',
        message: 'Webhook content type must be application/json.',
      });
    }
    const declaredLength = contentLength === undefined ? undefined : Number(contentLength);
    if (
      declaredLength !== undefined &&
      (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_WEBHOOK_BYTES)
    ) {
      throw new BadRequestException({
        error: 'WEBHOOK_BODY_TOO_LARGE',
        message: 'Webhook body exceeds the allowed size.',
      });
    }
    let measuredLength: number;
    try {
      measuredLength = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
      throw new BadRequestException({
        error: 'WEBHOOK_MALFORMED',
        message: 'Webhook body is malformed.',
      });
    }
    if (measuredLength > MAX_WEBHOOK_BYTES) {
      throw new BadRequestException({
        error: 'WEBHOOK_BODY_TOO_LARGE',
        message: 'Webhook body exceeds the allowed size.',
      });
    }
    return this.webhooks.ingest(body);
  }

  @Get('vnpay')
  @Public()
  @RateLimit({ identity: 'ip', limit: 120, name: 'vnpay-ipn', windowSeconds: 15 * 60 })
  @HttpCode(200)
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        RspCode: { type: 'string', example: '00' },
        Message: { type: 'string', example: 'Confirm Success' },
      },
      required: ['RspCode', 'Message'],
    },
  })
  async receiveVnPay(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const query = !isWellFormedVnPayQueryEncoding(request.originalUrl)
        ? undefined
        : request.query;
      response.status(200).json(await this.vnpayIpn.handle(query));
    } catch {
      response.status(200).json({ RspCode: '99', Message: 'Invalid request' });
    }
  }
}
