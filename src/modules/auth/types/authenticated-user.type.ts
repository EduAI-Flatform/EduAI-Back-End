import { RoleName } from '../../../../generated/prisma/client';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  roles: RoleName[];
  mfaRevision?: number;
  mfaVerified?: boolean;
  authTime?: number;
  tokenVersion?: 2;
  authRevision?: number;
  sid?: string;
}
