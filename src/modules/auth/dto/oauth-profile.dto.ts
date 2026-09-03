import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class OAuthProfileDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  ticket!: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  fullName?: string;
}
