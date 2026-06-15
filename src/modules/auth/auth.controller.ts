import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '../../../generated/prisma/client';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './roles.decorator';
import {
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
  RegisteredUserResponse,
  RegisterResponse,
} from './types/auth-response.types';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'User registered successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid registration payload.' })
  @ApiConflictResponse({ description: 'Email is already registered.' })
  async register(@Body() input: RegisterDto): Promise<RegisterResponse> {
    return this.authService.register(input);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'User authenticated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid login payload.' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials.' })
  async login(@Body() input: LoginDto): Promise<LoginResponse> {
    return this.authService.login(input);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Refresh token rotated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid refresh payload.' })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token.' })
  async refresh(@Body() input: RefreshTokenDto): Promise<RefreshResponse> {
    return this.authService.refresh(input);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Refresh token invalidated successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid logout payload.' })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token.' })
  async logout(@Body() input: RefreshTokenDto): Promise<LogoutResponse> {
    return this.authService.logout(input);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'Current user profile returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  async me(@CurrentUser('id') userId: string): Promise<RegisteredUserResponse> {
    return this.authService.getCurrentUser(userId);
  }

  @Get('admin-test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.platform_admin)
  @ApiOkResponse({ description: 'Admin test route accessed successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  async adminTest(): Promise<{ ok: true }> {
    return { ok: true };
  }
}
