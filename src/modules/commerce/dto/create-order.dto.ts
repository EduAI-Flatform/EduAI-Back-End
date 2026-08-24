import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export class VoucherApplicationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  courseId!: string;

  @ApiProperty({ example: 'EDUAI20' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,64}$/)
  code!: string;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ type: [VoucherApplicationDto], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VoucherApplicationDto)
  voucherApplications?: VoucherApplicationDto[];
}
