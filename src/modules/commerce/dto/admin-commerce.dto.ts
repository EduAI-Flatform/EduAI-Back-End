import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CommerceFulfillmentStatus,
  CommerceOrderStatus,
} from '../../../../generated/prisma/client';

const normalize = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export class ListCommerceCatalogQueryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100) pageSize = 25;
  @Transform(normalize) @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(['sellable', 'not_sellable', 'archived'])
  sellability?: 'sellable' | 'not_sellable' | 'archived';
}

export class UpdateCommerceCatalogDto {
  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  priceAmountMinor!: number;

  @ApiProperty({ enum: ['VND'] })
  @IsIn(['VND'])
  priceCurrency!: 'VND';

  @ApiProperty()
  @IsBoolean()
  sellable!: boolean;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  expectedCourseUpdatedAt!: string;
}

export class ListCommerceOrdersQueryDto {
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100) pageSize = 25;
  @Transform(normalize) @IsOptional() @IsString() @MaxLength(120) search?: string;
  @ApiPropertyOptional({ enum: CommerceOrderStatus })
  @IsOptional() @IsIn(Object.values(CommerceOrderStatus)) status?: CommerceOrderStatus;
  @ApiPropertyOptional({ enum: CommerceFulfillmentStatus })
  @IsOptional() @IsIn(Object.values(CommerceFulfillmentStatus))
  fulfillmentStatus?: CommerceFulfillmentStatus;
}
