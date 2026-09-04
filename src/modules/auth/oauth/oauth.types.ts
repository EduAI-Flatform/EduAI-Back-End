import { RoleName } from '../../../../generated/prisma/client';
import { LoginResponse } from '../types/auth-response.types';

export type SocialOAuthProvider = 'facebook' | 'zalo';
export type OAuthMode = 'login' | 'register';
export type OAuthRegistrationRole = Extract<RoleName, 'student' | 'instructor'>;

export interface OAuthStateRecord {
  provider: SocialOAuthProvider;
  mode: OAuthMode;
  role?: OAuthRegistrationRole;
  redirectTo: string;
  codeVerifier?: string;
  createdAt: number;
}

export interface OAuthTicketRecord {
  // `profile` remains readable for the short-lived tickets issued by the
  // previous deployment. New tickets always use the onboarding state.
  kind: 'session' | 'onboarding' | 'profile';
  mode: OAuthMode;
  provider: SocialOAuthProvider;
  redirectTo: string;
  userId?: string;
  externalIdentityId?: string;
  role?: OAuthRegistrationRole;
  displayName?: string;
  requiresEmail?: boolean;
  expiresAt: number;
}

export interface OAuthIdentity {
  providerUserId: string;
  email?: string;
  emailVerified: boolean;
  fullName?: string;
  avatarUrl?: string;
}

export interface OAuthProviderCapabilities {
  google: boolean;
  facebook: boolean;
  zalo: boolean;
}

export interface OAuthOnboardingResponse {
  kind: 'onboarding';
  provider: SocialOAuthProvider;
  ticket: string;
  redirectTo: string;
  requiresEmail: boolean;
  role?: OAuthRegistrationRole;
  displayName?: string;
}

/** Transitional response type for clients that still understand the old flow. */
export interface OAuthProfileRequiredResponse {
  kind: 'profile_required';
  provider: SocialOAuthProvider;
  ticket: string;
  redirectTo: string;
  displayName?: string;
}

export interface OAuthSessionResponse {
  kind: 'session';
  session: LoginResponse;
  redirectTo: string;
}

export type OAuthExchangeResponse =
  | OAuthOnboardingResponse
  | OAuthProfileRequiredResponse
  | OAuthSessionResponse;

export interface OAuthProfileCompletionInput {
  role: OAuthRegistrationRole;
  email?: string;
  fullName?: string;
}
