import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { TmiRewardKind } from '../../../../generated/prisma/client';

export class CreateTmiRewardDto {
  @ApiProperty() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string | null;
  @ApiProperty({ enum: TmiRewardKind }) @IsEnum(TmiRewardKind) kind!: TmiRewardKind;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483647) cost!: number;
  @ApiProperty() @IsDateString() startsAt!: string;
  @ApiProperty() @IsDateString() endsAt!: string;
  @ApiPropertyOptional({ nullable: true, minimum: 1 }) @IsOptional() @IsInt() @Min(1) quota?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsObject() inventoryMetadata?: Record<string, unknown> | null;
}
