import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class PaymentLifecycleResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ example: 'CANCELLED' }) orderStatus!: string;
  @ApiProperty({ example: 'CANCELLED', nullable: true }) paymentStatus!: string | null;
}

export class RunPaymentExpiryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional() @IsUUID('4') cursor?: string;
}
