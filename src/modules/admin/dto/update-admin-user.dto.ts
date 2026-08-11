import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
} from 'class-validator';
import { RoleName, UserStatus } from '../../../../generated/prisma/client';

export class UpdateAdminUserStatusDto {
  @ApiProperty({ enum: [UserStatus.active, UserStatus.suspended] })
  @IsIn([UserStatus.active, UserStatus.suspended])
  status!: Extract<UserStatus, 'active' | 'suspended'>;
}

export class UpdateAdminUserRolesDto {
  @ApiProperty({ enum: RoleName, isArray: true, minItems: 1, uniqueItems: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(RoleName, { each: true })
  roles!: RoleName[];
}
