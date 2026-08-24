import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const CART_AVAILABILITIES = [
  'AVAILABLE',
  'ALREADY_OWNED',
  'COURSE_UNAVAILABLE',
  'PAYMENT_NOT_REQUIRED',
  'UNSUPPORTED_CURRENCY',
] as const;

export type CartAvailability = (typeof CART_AVAILABILITIES)[number];

export class MoneyResponseDto {
  @ApiProperty({ example: '250000' })
  amountMinor!: string;

  @ApiProperty({ example: 'VND' })
  currency!: string;
}

export class CartCourseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true })
  thumbnailUrl!: string | null;
}

export class CartItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ type: CartCourseResponseDto })
  course!: CartCourseResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  unitPrice!: MoneyResponseDto;

  @ApiProperty({ example: 1 })
  quantity!: 1;

  @ApiProperty({ enum: CART_AVAILABILITIES })
  availability!: CartAvailability;

  @ApiProperty({ type: [String] })
  warnings!: string[];
}

export class CartSummaryResponseDto {
  @ApiProperty({ example: '250000' })
  subtotalAmountMinor!: string;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({ example: 1 })
  itemCount!: number;

  @ApiProperty()
  canCheckout!: boolean;
}

export class CartResponseDto {
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  id!: string | null;

  @ApiProperty({ example: 'ACTIVE' })
  status!: 'ACTIVE';

  @ApiProperty({ example: 'VND' })
  currency!: 'VND';

  @ApiProperty({ type: [CartItemResponseDto] })
  items!: CartItemResponseDto[];

  @ApiProperty({ type: CartSummaryResponseDto })
  summary!: CartSummaryResponseDto;
}
