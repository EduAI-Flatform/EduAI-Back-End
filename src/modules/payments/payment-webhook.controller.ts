import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/security/public.decorator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { PaymentWebhookResponseDto } from './dto/payment-webhook-response.dto';
import { PaymentWebhookService } from './payment-webhook.service';

const MAX_WEBHOOK_BYTES = 32 * 1024;

@ApiTags('Payments')
@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

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
}
