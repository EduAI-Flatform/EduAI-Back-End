import { SetMetadata } from '@nestjs/common';
import { RoleName } from '../../../generated/prisma/client';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: RoleName[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, roles);
