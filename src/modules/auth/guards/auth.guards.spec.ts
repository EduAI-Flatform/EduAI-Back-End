import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { RoleName } from '../../../../generated/prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { ROLES_KEY } from '../roles.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

function createHttpContext(headers: Record<string, string | undefined> = {}): ExecutionContext {
  const request = { headers };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  function createGuard(options?: { payload?: unknown; verifyFails?: boolean }) {
    const jwtService = {
      verifyAsync: jest.fn(
        options?.verifyFails
          ? async () => {
              throw new Error('invalid token');
            }
          : async () =>
              options?.payload ?? {
                sub: 'user-id',
                email: 'admin@example.com',
                roles: [RoleName.platform_admin],
              },
      ),
    } as unknown as JwtService;
    const appConfig = {
      jwt: {
        accessSecret: 'access-secret',
      },
    } as AppConfigService;

    return {
      guard: new JwtAuthGuard(jwtService, appConfig),
      jwtService,
    };
  }

  it('rejects requests without a bearer token', async () => {
    const { guard } = createGuard();

    await expect(guard.canActivate(createHttpContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects invalid access tokens', async () => {
    const { guard } = createGuard({ verifyFails: true });

    await expect(
      guard.canActivate(createHttpContext({ authorization: 'Bearer bad-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the verified user payload to the request', async () => {
    const { guard, jwtService } = createGuard();
    const context = createHttpContext({ authorization: 'Bearer access-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('access-token', {
      secret: 'access-secret',
    });
    expect(context.switchToHttp().getRequest().user).toEqual({
      id: 'user-id',
      email: 'admin@example.com',
      roles: [RoleName.platform_admin],
    });
  });
});

describe('RolesGuard', () => {
  function createGuard(requiredRoles: RoleName[]) {
    const reflector = {
      getAllAndOverride: jest.fn().mockImplementation((key: string) => {
        if (key === ROLES_KEY) {
          return requiredRoles;
        }

        return undefined;
      }),
    } as unknown as Reflector;

    return new RolesGuard(reflector);
  }

  it('rejects authenticated users without a required role', () => {
    const guard = createGuard([RoleName.platform_admin]);
    const context = createHttpContext();
    context.switchToHttp().getRequest().user = {
      id: 'user-id',
      roles: [RoleName.student],
    };

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows platform admins through admin routes', () => {
    const guard = createGuard([RoleName.platform_admin]);
    const context = createHttpContext();
    context.switchToHttp().getRequest().user = {
      id: 'admin-id',
      roles: [RoleName.platform_admin],
    };

    expect(guard.canActivate(context)).toBe(true);
  });
});
