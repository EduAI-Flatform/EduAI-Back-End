import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefundTmiRedemptionDto {
  @ApiPropertyOptional({ example: 'Reward unavailable after approval' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
