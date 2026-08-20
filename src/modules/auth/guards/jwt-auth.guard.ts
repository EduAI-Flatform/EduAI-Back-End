import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserStatus } from '../../../../generated/prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { IS_PUBLIC_KEY } from '../../../common/security/public.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../types/authenticated-user.type';

interface AccessTokenPayload {
  sub?: string;
}

const AUTHENTICATED_REQUEST = Symbol('authenticatedRequest');

interface AuthenticatedRequest extends Request {
  [AUTHENTICATED_REQUEST]?: boolean;
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    return this.authenticate(context);
  }

  protected async authenticate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request[AUTHENTICATED_REQUEST]) return true;

    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.appConfig.jwt.accessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('Invalid access token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        status: true,
        deletedAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });

    if (!user || user.deletedAt || user.status !== UserStatus.active) {
      throw new UnauthorizedException('Invalid access token');
    }

    request.user = {
      id: user.id,
      email: user.email,
      roles: user.roles.map(({ role }) => role.name),
    };
    request[AUTHENTICATED_REQUEST] = true;

    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const authorization = request.headers.authorization;

    if (!authorization) {
      return undefined;
    }

    const [type, token] = authorization.split(' ');

    if (type !== 'Bearer' || !token) {
      return undefined;
    }

    return token;
  }
}
