import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsString, IsUUID, Matches, Max, Min, MinLength, MaxLength } from 'class-validator';
import { TmiAdjustmentDirection } from '../../../../generated/prisma/client';

export class AdjustTmiBalanceDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ minimum: 1 })
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(2147483647)
  amount!: number;

  @ApiProperty({ enum: TmiAdjustmentDirection })
  @IsEnum(TmiAdjustmentDirection)
  direction!: TmiAdjustmentDirection;

  @ApiProperty({ example: 'manual-adjustment-2026-08-18-001' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  adjustmentKey!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
