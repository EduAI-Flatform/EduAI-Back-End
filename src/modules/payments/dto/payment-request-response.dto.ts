import { ApiProperty } from '@nestjs/swagger';

export class PaymentAmountResponseDto {
  @ApiProperty({ example: '125000' })
  amountMinor!: string;

  @ApiProperty({ example: 'VND' })
  currency!: 'VND';
}

export class PaymentAttemptResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'PENDING' })
  status!: string;

  @ApiProperty({ type: PaymentAmountResponseDto })
  amount!: PaymentAmountResponseDto;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ required: false })
  checkoutUrl?: string;

  @ApiProperty({ required: false, description: 'Short-lived QR image data returned only from successful creation.' })
  qrCodeDataUrl?: string;
}

export class PaymentRequestResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ example: 'PENDING_PAYMENT' })
  orderStatus!: string;

  @ApiProperty()
  paymentRequired!: boolean;

  @ApiProperty({ type: PaymentAttemptResponseDto, nullable: true })
  payment!: PaymentAttemptResponseDto | null;
}
