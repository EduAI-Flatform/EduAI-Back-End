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
      'GDS_TOPUP_RECEIVED',
      'GDS_TOPUP_DUPLICATE',
      'GDS_TOPUP_REVIEW',
    ],
  })
  result!:
    | 'CONFIRMED'
    | 'DUPLICATE'
    | 'LATE_PAYMENT_REVIEW'
    | 'UNKNOWN_PAYMENT_ACKNOWLEDGED'
    | 'GDS_TOPUP_RECEIVED'
    | 'GDS_TOPUP_DUPLICATE'
    | 'GDS_TOPUP_REVIEW';
}
