import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class OAuthCallbackDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  error?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  error_description?: string;
}
