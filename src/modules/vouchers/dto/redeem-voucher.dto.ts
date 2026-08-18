import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RedeemVoucherDto {
  @ApiProperty({ example: 'EDUAI20' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]{3,64}$/)
  code!: string;

  @ApiProperty({ example: 'checkout-session-2026-08-18-001' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  redemptionKey!: string;
}
