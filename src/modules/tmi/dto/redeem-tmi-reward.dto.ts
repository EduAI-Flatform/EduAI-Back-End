import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RedeemTmiRewardDto {
  @ApiProperty({ example: 'tmi-redemption-2026-08-18-001' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey!: string;
}
