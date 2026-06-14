import { RoleName } from '../../../../generated/prisma/client';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  roles: RoleName[];
}
