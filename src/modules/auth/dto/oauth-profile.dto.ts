import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RoleName } from '../../../../generated/prisma/client';

export class OAuthProfileDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  ticket!: string;

  @IsIn([RoleName.student, RoleName.instructor])
  role!: Extract<RoleName, 'student' | 'instructor'>;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  fullName?: string;
}
