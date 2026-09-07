import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

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

  @ApiPropertyOptional()
  checkoutUrl?: string;

  @ApiPropertyOptional({ description: 'Short-lived QR image data returned only from successful creation.' })
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

export class ListPendingPaymentQueryDto {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100)
  pageSize = 20;
}

export class PaymentRequestPageResponseDto {
  @ApiProperty({ type: [PaymentRequestResponseDto] })
  items!: PaymentRequestResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
