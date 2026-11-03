import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class RevenueRetailPolicyDto {
  @ApiProperty({ minimum: 0, maximum: 10000 }) @IsInt() @Min(0) @Max(10000)
  platformFeeBps!: number;
  @ApiProperty({ enum: ['immediate', 'delayed'] }) @IsIn(['immediate', 'delayed'])
  noticeMode!: 'immediate' | 'delayed';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(3650)
  noticeDays?: number;
}
export class RevenuePageDto {
  @ApiPropertyOptional({ default: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(1000000)
  page = 1;
  @ApiPropertyOptional({ default: 25 }) @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 25;
}