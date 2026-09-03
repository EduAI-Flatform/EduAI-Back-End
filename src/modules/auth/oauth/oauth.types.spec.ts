import { RoleName } from '../../../../generated/prisma/client';
import {
  OAuthExchangeResponse,
  OAuthStateRecord,
  OAuthTicketRecord,
} from './oauth.types';

describe('OAuth contracts', () => {
  it('keeps state bound to one provider, mode, role, and local redirect', () => {
    const state: OAuthStateRecord = {
      provider: 'facebook',
      mode: 'register',
      role: RoleName.instructor,
      redirectTo: '/instructor/dashboard',
      createdAt: Date.now(),
    };

    expect(state).toMatchObject({
      provider: 'facebook',
      mode: 'register',
      role: RoleName.instructor,
      redirectTo: '/instructor/dashboard',
    });
  });

  it('models missing-email onboarding without exposing provider credentials', () => {
    const ticket: OAuthTicketRecord = {
      kind: 'profile',
      provider: 'zalo',
      externalIdentityId: 'external-identity-id',
      redirectTo: '/',
      role: RoleName.student,
      displayName: 'Zalo Learner',
      expiresAt: Date.now() + 120_000,
    };
    const response: OAuthExchangeResponse = {
      kind: 'profile_required',
      provider: ticket.provider,
      ticket: 'one-time-eduai-ticket',
      redirectTo: ticket.redirectTo,
      displayName: ticket.displayName,
    };

    expect(JSON.stringify({ ticket, response })).not.toMatch(
      /access_token|refresh_token|client_secret|code/i,
    );
  });
});
