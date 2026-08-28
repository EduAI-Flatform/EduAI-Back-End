import { ApiProperty } from '@nestjs/swagger';

export class PaymentWebhookResponseDto {
  @ApiProperty({ example: true })
  accepted!: true;

  @ApiProperty({
    enum: [
      'CONFIRMED',
      'DUPLICATE',
      'LATE_PAYMENT_REVIEW',
      'UNKNOWN_PAYMENT_ACKNOWLEDGED',
    ],
  })
  result!:
    | 'CONFIRMED'
    | 'DUPLICATE'
    | 'LATE_PAYMENT_REVIEW'
    | 'UNKNOWN_PAYMENT_ACKNOWLEDGED';
}
