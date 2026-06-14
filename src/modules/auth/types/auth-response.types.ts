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

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: RegisteredUserResponse;
}

export type RefreshResponse = LoginResponse;

export interface LogoutResponse {
  loggedOut: true;
}
