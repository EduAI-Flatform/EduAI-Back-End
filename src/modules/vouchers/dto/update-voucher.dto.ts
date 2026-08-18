import { PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { VoucherStatus } from '../../../../generated/prisma/client';
import { CreateVoucherDto } from './create-voucher.dto';

export class UpdateVoucherDto extends PartialType(CreateVoucherDto) {
  @IsOptional()
  @IsEnum(VoucherStatus)
  status?: VoucherStatus;
}
