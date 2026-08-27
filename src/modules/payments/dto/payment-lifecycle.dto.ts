import { ApiProperty } from '@nestjs/swagger';

export class PaymentLifecycleResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ example: 'CANCELLED' }) orderStatus!: string;
  @ApiProperty({ example: 'CANCELLED', nullable: true }) paymentStatus!: string | null;
}
