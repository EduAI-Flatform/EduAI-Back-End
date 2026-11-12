import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { RateLimit } from '../../common/security/rate-limit.decorator';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthSecurityService } from './auth-security.service';

class ChangeAccountPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(72) newPassword!: string;
}
class FirebasePasswordProofDto { @IsString() @MinLength(20) @MaxLength(10000) idToken!: string; }

@Controller('auth/security') @ApiTags('Account security') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
export class AuthSecurityController {
  constructor(private readonly security: AuthSecurityService) {}
  @Get() capabilities(@CurrentUser('id') userId: string) { return this.security.capabilities(userId); }
  @Post('password') @RateLimit({ identity: 'user', limit: 5, name: 'account-password-change', windowSeconds: 900 })
  change(@CurrentUser('id') userId: string, @Body() body: ChangeAccountPasswordDto) {
    return this.security.changePassword(userId, body.currentPassword, body.newPassword);
  }
  @Post('firebase-password-sessions') @RateLimit({ identity: 'user', limit: 5, name: 'account-firebase-password-change', windowSeconds: 900 })
  revokeFirebase(@CurrentUser('id') userId: string, @Body() body: FirebasePasswordProofDto) {
    return this.security.revokeFirebaseSessions(userId, body.idToken);
  }
}
