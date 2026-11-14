import { Body, Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AllowMfaPending } from './mfa.decorator';
import { MfaService } from './mfa.service';
import { AuthenticatedUser } from './types/authenticated-user.type';

class MfaCodeDto {
  @IsString()
  @Matches(/^(?:\d{6}|[A-Fa-f0-9]{6}(?:-[A-Fa-f0-9]{6}){3})$/)
  code!: string;
}

@ApiTags('Authenticator security')
@ApiBearerAuth()
@Controller('auth/mfa')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService, private readonly auth: AuthService) {}
  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser('id') userId: string) { return this.mfa.status(userId); }

  @Post('enroll')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 5, name: 'mfa-enroll', windowSeconds: 900 })
  enroll(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.enroll(user.id, user.email ?? user.id, user.authTime);
  }

  @Post('confirm')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 5, name: 'mfa-confirm', windowSeconds: 300 })
  async confirm(@CurrentUser() user: AuthenticatedUser, @Body() body: MfaCodeDto) {
    return this.auth.confirmMfa(user, body.code);
  }

  @Post('verify')
  @Header('Cache-Control', 'no-store')
  @AllowMfaPending()
  @RateLimit({ identity: 'user', limit: 5, name: 'mfa-verify', windowSeconds: 300 })
  async verify(@CurrentUser() user: AuthenticatedUser, @Body() body: MfaCodeDto) {
    return this.auth.verifyMfa(user, body.code);
  }

  @Post('disable')
  @RateLimit({ identity: 'user', limit: 5, name: 'mfa-disable', windowSeconds: 300 })
  disable(@CurrentUser() user: AuthenticatedUser, @Body() body: MfaCodeDto) {
    return this.mfa.disable(user.id, body.code, user.authTime);
  }

  @Post('recovery-codes')
  @Header('Cache-Control', 'no-store')
  @RateLimit({ identity: 'user', limit: 5, name: 'mfa-recovery', windowSeconds: 300 })
  async recovery(@CurrentUser() user: AuthenticatedUser, @Body() body: MfaCodeDto) {
    return this.auth.regenerateMfaRecoveryCodes(user, body.code);
  }
}
