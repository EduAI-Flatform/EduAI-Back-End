import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RoleName, UserStatus } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import {
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
  RegisteredUserResponse,
  RegisterResponse,
} from './types/auth-response.types';

const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;
const REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

interface JwtPayload {
  sub: string;
  email?: string;
  roles?: RoleName[];
}

interface RefreshTokenRecord {
  id: string;
  tokenHash: string;
}

interface RefreshTokenWriter {
  refreshToken: {
    create(input: {
      data: {
        expiresAt: Date;
        tokenHash: string;
        userId: string;
      };
    }): Promise<unknown>;
  };
}

interface AuthUserRecord {
  createdAt: Date;
  email: string;
  fullName: string;
  id: string;
  roles: Array<{
    role: {
      name: RoleName;
    };
  }>;
  status: UserStatus;
  updatedAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly appConfig: AppConfigService,
  ) {}

  async register(input: RegisterDto): Promise<RegisterResponse> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    const passwordHash = await this.passwordService.hashPassword(input.password);
    const requestedRole = input.role ?? RoleName.student;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (existingUser) {
          throw new ConflictException('Email is already registered');
        }

        const role = await tx.role.findUnique({
          where: { name: requestedRole },
          select: { id: true, name: true },
        });

        if (!role) {
          throw new InternalServerErrorException('Registration role is missing');
        }

        const user = await tx.user.create({
          data: {
            email,
            fullName,
            passwordHash,
          },
          select: {
            createdAt: true,
            email: true,
            fullName: true,
            id: true,
            status: true,
            updatedAt: true,
          },
        });

        await tx.userRole.create({
          data: {
            roleId: role.id,
            userId: user.id,
          },
        });

        return {
          user: {
            ...user,
            roles: [role.name],
          },
        };
      });
    } catch (error) {
      if (this.isEmailConflict(error)) {
        throw new ConflictException('Email is already registered');
      }

      throw error;
    }
  }

  async login(input: LoginDto): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        passwordHash: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        status: true,
        updatedAt: true,
      },
    });

    if (!user || user.status !== UserStatus.active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await this.passwordService.comparePassword(
      input.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokenResponse(user, this.prisma);
  }

  async refresh(input: RefreshTokenDto): Promise<RefreshResponse> {
    const payload = await this.verifyRefreshToken(input.refreshToken);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: payload.sub },
        select: {
          createdAt: true,
          email: true,
          fullName: true,
          id: true,
          refreshTokens: {
            where: {
              expiresAt: { gt: new Date() },
              revokedAt: null,
            },
            select: {
              id: true,
              tokenHash: true,
            },
          },
          roles: {
            select: {
              role: {
                select: {
                  name: true,
                },
              },
            },
          },
          status: true,
          updatedAt: true,
        },
      });

      if (!user || user.status !== UserStatus.active) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const storedToken = await this.findMatchingRefreshToken(
        input.refreshToken,
        user.refreshTokens,
      );

      if (!storedToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      await tx.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      return this.issueTokenResponse(user, tx);
    });
  }

  async logout(input: RefreshTokenDto): Promise<LogoutResponse> {
    const payload = await this.verifyRefreshToken(input.refreshToken);
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        refreshTokens: {
          where: {
            expiresAt: { gt: new Date() },
            revokedAt: null,
          },
          select: {
            id: true,
            tokenHash: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const storedToken = await this.findMatchingRefreshToken(
      input.refreshToken,
      user.refreshTokens,
    );

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    return { loggedOut: true };
  }

  async getCurrentUser(userId: string): Promise<RegisteredUserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
              },
            },
          },
        },
        status: true,
        updatedAt: true,
      },
    });

    if (!user || user.status !== UserStatus.active) {
      throw new UnauthorizedException('Invalid access token');
    }

    return this.toRegisteredUserResponse(user);
  }

  private getRequiredJwtSecret(key: 'accessSecret' | 'refreshSecret'): string {
    const secret = this.appConfig.jwt[key];

    if (!secret) {
      throw new InternalServerErrorException('JWT secret is not configured');
    }

    return secret;
  }

  private async verifyRefreshToken(refreshToken: string): Promise<JwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        refreshToken,
        {
          secret: this.getRequiredJwtSecret('refreshSecret'),
        },
      );

      if (!payload.sub) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async findMatchingRefreshToken(
    refreshToken: string,
    storedTokens: RefreshTokenRecord[],
  ): Promise<RefreshTokenRecord | undefined> {
    for (const storedToken of storedTokens) {
      const matches = await this.passwordService.comparePassword(
        refreshToken,
        storedToken.tokenHash,
      );

      if (matches) {
        return storedToken;
      }
    }

    return undefined;
  }

  private async issueTokenResponse(
    user: AuthUserRecord,
    refreshTokenWriter: RefreshTokenWriter,
  ): Promise<LoginResponse> {
    const responseUser = this.toRegisteredUserResponse(user);
    const payload = {
      sub: responseUser.id,
      email: responseUser.email,
      roles: responseUser.roles,
    };
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      secret: this.getRequiredJwtSecret('accessSecret'),
    });
    const refreshToken = await this.jwtService.signAsync(payload, {
      expiresIn: REFRESH_TOKEN_EXPIRES_IN_SECONDS,
      secret: this.getRequiredJwtSecret('refreshSecret'),
    });
    const refreshTokenHash =
      await this.passwordService.hashPassword(refreshToken);

    await refreshTokenWriter.refreshToken.create({
      data: {
        expiresAt: new Date(
          Date.now() + REFRESH_TOKEN_EXPIRES_IN_SECONDS * 1000,
        ),
        tokenHash: refreshTokenHash,
        userId: responseUser.id,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      user: responseUser,
    };
  }

  private toRegisteredUserResponse(
    user: AuthUserRecord,
  ): RegisteredUserResponse {
    return {
      createdAt: user.createdAt,
      email: user.email,
      fullName: user.fullName,
      id: user.id,
      roles: user.roles.map((userRole) => userRole.role.name),
      status: user.status,
      updatedAt: user.updatedAt,
    };
  }

  private isEmailConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002' &&
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'target' in error.meta &&
      Array.isArray(error.meta.target) &&
      error.meta.target.includes('email')
    );
  }
}
