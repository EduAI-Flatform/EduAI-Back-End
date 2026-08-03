import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AuthProvider,
  RoleName,
  UserStatus,
} from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import {
  FIREBASE_ADMIN_SERVICE,
  type FirebaseAdminVerifier,
} from '../firebase/firebase-admin.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
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

interface FirebaseTokenClaims {
  email?: string;
  email_verified?: boolean;
  firebase?: {
    sign_in_provider?: string;
  };
  name?: string;
  picture?: string;
  uid?: string;
}

const FIREBASE_USER_SELECT = {
  avatarUrl: true,
  createdAt: true,
  email: true,
  firebaseUid: true,
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
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly appConfig: AppConfigService,
    @Optional()
    @Inject(FIREBASE_ADMIN_SERVICE)
    private readonly firebaseAdmin?: FirebaseAdminVerifier,
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

    if (!user || user.status !== UserStatus.active || !user.passwordHash) {
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

  async loginWithFirebase(input: FirebaseLoginDto): Promise<LoginResponse> {
    const token = await this.verifyFirebaseToken(input.idToken);
    const uid = token.uid?.trim();
    const email = token.email?.trim().toLowerCase();

    if (
      !uid ||
      !email ||
      token.email_verified !== true ||
      token.firebase?.sign_in_provider !== 'google.com'
    ) {
      throw new UnauthorizedException('Invalid Firebase authentication token');
    }

    const fullName = this.getFirebaseFullName(token.name, email);
    const avatarUrl = this.getOptionalValue(token.picture);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingByFirebaseUid = await tx.user.findUnique({
          where: { firebaseUid: uid },
          select: FIREBASE_USER_SELECT,
        });
        const existingByEmail = await tx.user.findUnique({
          where: { email },
          select: FIREBASE_USER_SELECT,
        });

        if (
          existingByFirebaseUid &&
          existingByEmail &&
          existingByFirebaseUid.id !== existingByEmail.id
        ) {
          throw new ConflictException(
            'Firebase account is linked to a different email',
          );
        }

        const existingUser = existingByFirebaseUid ?? existingByEmail;

        if (existingUser) {
          if (existingUser.status !== UserStatus.active) {
            throw new UnauthorizedException(
              'Invalid Firebase authentication token',
            );
          }

          const updateData: {
            authProvider: AuthProvider;
            avatarUrl?: string;
            emailVerified: boolean;
            firebaseUid?: string;
            fullName?: string;
          } = {
            authProvider: AuthProvider.google,
            emailVerified: true,
          };

          if (!existingUser.firebaseUid) {
            updateData.firebaseUid = uid;
          }
          if (!existingUser.fullName.trim() && fullName) {
            updateData.fullName = fullName;
          }
          if (!existingUser.avatarUrl?.trim() && avatarUrl) {
            updateData.avatarUrl = avatarUrl;
          }

          const user = await tx.user.update({
            where: { id: existingUser.id },
            data: updateData,
            select: FIREBASE_USER_SELECT,
          });

          return this.issueTokenResponse(user, tx);
        }

        const role = await tx.role.findUnique({
          where: { name: RoleName.student },
          select: { id: true, name: true },
        });

        if (!role) {
          throw new InternalServerErrorException('Registration role is missing');
        }

        const user = await tx.user.create({
          data: {
            authProvider: AuthProvider.google,
            avatarUrl,
            email,
            emailVerified: true,
            firebaseUid: uid,
            fullName,
            passwordHash: null,
          },
          select: FIREBASE_USER_SELECT,
        });

        await tx.userRole.create({
          data: {
            roleId: role.id,
            userId: user.id,
          },
        });

        return this.issueTokenResponse(
          { ...user, roles: [{ role }] },
          tx,
        );
      });
    } catch (error) {
      if (this.isEmailConflict(error)) {
        throw new ConflictException('Email is already registered');
      }
      if (this.isUniqueConflict(error, 'firebaseUid')) {
        throw new ConflictException('Firebase account is already linked');
      }

      throw error;
    }
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

  private async verifyFirebaseToken(
    idToken: string,
  ): Promise<FirebaseTokenClaims> {
    if (!this.firebaseAdmin) {
      throw new InternalServerErrorException(
        'Firebase authentication is not configured',
      );
    }

    try {
      return await this.firebaseAdmin.verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid Firebase authentication token');
    }
  }

  private getFirebaseFullName(name: string | undefined, email: string): string {
    return this.getOptionalValue(name) ?? email.split('@')[0] ?? email;
  }

  private getOptionalValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
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
    return this.isUniqueConflict(error, 'email');
  }

  private isUniqueConflict(error: unknown, field: string): boolean {
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
      error.meta.target.includes(field)
    );
  }
}
