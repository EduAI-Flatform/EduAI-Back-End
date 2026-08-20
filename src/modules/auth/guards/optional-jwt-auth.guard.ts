import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppConfigService } from '../../../config/app-config.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Parses an access token when one is supplied while keeping public routes
 * accessible to anonymous visitors. Invalid supplied credentials still fail.
 */
@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  constructor(
    jwtService: JwtService,
    appConfig: AppConfigService,
    prisma: PrismaService,
    reflector: Reflector,
  ) {
    super(jwtService, appConfig, prisma, reflector);
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.headers.authorization) {
      return Promise.resolve(true);
    }

    return this.authenticate(context);
  }
}
