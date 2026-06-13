import { RoleName, UserStatus } from '../../../../generated/prisma/client';

export interface RegisteredUserResponse {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  roles: RoleName[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterResponse {
  user: RegisteredUserResponse;
}
