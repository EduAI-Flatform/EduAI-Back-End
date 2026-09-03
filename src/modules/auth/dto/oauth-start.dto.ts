import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import {
  OAuthMode,
  OAuthRegistrationRole,
} from '../oauth/oauth.types';

export class OAuthStartDto {
  @ApiPropertyOptional({ enum: ['login', 'register'], default: 'login' })
  @IsOptional()
  @IsIn(['login', 'register'])
  mode?: OAuthMode;

  @ApiPropertyOptional({ enum: ['student', 'instructor'] })
  @IsOptional()
  @IsIn(['student', 'instructor'])
  role?: OAuthRegistrationRole;

  @ApiPropertyOptional({
    description: 'Allowlisted local path used after EduAI session creation.',
    example: '/courses',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^\/(?!\/)[^\\#]*$/)
  redirectTo?: string;
}
