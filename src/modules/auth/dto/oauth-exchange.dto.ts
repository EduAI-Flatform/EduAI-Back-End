import { IsString, MaxLength, MinLength } from 'class-validator';

export class OAuthExchangeDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  ticket!: string;
}
