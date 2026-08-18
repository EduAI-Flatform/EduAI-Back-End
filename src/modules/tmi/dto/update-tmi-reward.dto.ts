import { PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { TmiRewardStatus } from '../../../../generated/prisma/client';
import { CreateTmiRewardDto } from './create-tmi-reward.dto';
export class UpdateTmiRewardDto extends PartialType(CreateTmiRewardDto) {
  @IsOptional() @IsEnum(TmiRewardStatus) status?: TmiRewardStatus;
}
