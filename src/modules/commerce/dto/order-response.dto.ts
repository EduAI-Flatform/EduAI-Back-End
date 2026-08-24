import { ApiProperty } from '@nestjs/swagger';
import { MoneyResponseDto } from './commerce-response.dto';

export class OrderBenefitResponseDto {
  @ApiProperty({ example: 'VOUCHER' })
  type!: 'VOUCHER';

  @ApiProperty({ format: 'uuid' })
  sourceId!: string;

  @ApiProperty({ type: MoneyResponseDto })
  discount!: MoneyResponseDto;
}

export class OrderLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: MoneyResponseDto })
  unitListPrice!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  finalPrice!: MoneyResponseDto;

  @ApiProperty({ type: [OrderBenefitResponseDto] })
  benefits!: OrderBenefitResponseDto[];
}

export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ example: 'PENDING_PAYMENT' })
  status!: string;

  @ApiProperty({ example: 'NOT_STARTED' })
  fulfillmentStatus!: string;

  @ApiProperty({ type: MoneyResponseDto })
  subtotal!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  discount!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  payable!: MoneyResponseDto;

  @ApiProperty()
  pricingPolicyVersion!: string;

  @ApiProperty({ type: [OrderLineResponseDto] })
  lines!: OrderLineResponseDto[];
}
