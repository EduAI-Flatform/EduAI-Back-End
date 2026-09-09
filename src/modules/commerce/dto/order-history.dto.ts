import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MoneyResponseDto } from './commerce-response.dto';

export class ListOrdersQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class OrderHistoryLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'COURSE' })
  productType!: string;

  @ApiProperty({ format: 'uuid' })
  productReferenceId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ type: MoneyResponseDto })
  unitListPrice!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  finalPrice!: MoneyResponseDto;
}

export class OrderHistoryPaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'PENDING' })
  status!: string;

  @ApiProperty({ type: MoneyResponseDto })
  amount!: MoneyResponseDto;

  @ApiPropertyOptional()
  expiresAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class OrderHistoryItemResponseDto {
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
  paymentRequired!: boolean;

  @ApiProperty({ type: [OrderHistoryLineResponseDto] })
  lines!: OrderHistoryLineResponseDto[];

  @ApiProperty({ type: OrderHistoryPaymentResponseDto, nullable: true })
  payment!: OrderHistoryPaymentResponseDto | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional()
  confirmedAt!: Date | null;

  @ApiPropertyOptional()
  cancelledAt!: Date | null;

  @ApiPropertyOptional()
  expiredAt!: Date | null;
}

export class OrderHistoryPageResponseDto {
  @ApiProperty({ type: [OrderHistoryItemResponseDto] })
  items!: OrderHistoryItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
