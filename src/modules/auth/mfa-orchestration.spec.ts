import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';

describe('MFA HTTP transaction orchestration', () => {
  function setup(action: 'verify' | 'confirm' | 'recovery') {
    const state = { enabled: action !== 'confirm', revision: action === 'confirm' ? 0 : 2 };
    const primary = { revision: 0, familyActive: true };
    const user = { id: 'owner', email: 'owner@example.test', roles: ['student'], authTime: Math.floor(Date.now() / 1000),
      tokenVersion: 2, authRevision: 0, sid: '00000000-0000-4000-8000-000000000001',
      mfaRevision: state.revision, mfaVerified: action === 'recovery' };
    let active = false;
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ status: 'active', deletedAt: null }]),
      userMfa: { findUnique: jest.fn(async () => ({ ...state })) },
      user: { findUnique: jest.fn(async () => ({ ...user, authRevision: primary.revision, status: 'active', deletedAt: null,
        createdAt: new Date(), updatedAt: new Date(), fullName: 'Owner', roles: [{ role: { name: 'student' } }] })) },
      refreshToken: { create: jest.fn(), findFirst: jest.fn(async () => primary.familyActive ? { id: 'active-row' } : null) } };
    const prisma: any = { userMfa: tx.userMfa, $transaction: jest.fn(async (work: any) => {
      if (active) throw new Error('Unexpected nested transaction');
      active = true;
      try { return await work(tx); } finally { active = false; }
    }) };
    const realClaims = new MfaService(prisma);
    const requireCaller = (client: unknown) => {
      if (!active || client !== tx) throw new Error('MFA proof is outside the issuance transaction');
    };
    const mfa: any = {
      claims: jest.fn(realClaims.claims.bind(realClaims)), assertFreshPrimary: realClaims.assertFreshPrimary.bind(realClaims),
      verify: jest.fn(async (_id: string, _code: string, _revision: number, client: unknown) => {
        requireCaller(client); return state.revision;
      }),
      confirm: jest.fn(async (_id: string, _code: string, _time: number, client: unknown) => {
        requireCaller(client); state.enabled = true; state.revision++; return { revision: state.revision, recoveryCodes: ['synthetic-code'] };
      }),
      regenerateRecoveryCodes: jest.fn(async (_id: string, _code: string, _time: number, client: unknown) => {
        requireCaller(client); state.revision++; return { revision: state.revision, recoveryCodes: ['synthetic-code'] };
      }),
      enroll: jest.fn(async (_id: string, _email: string, _time: number, client: unknown) => { requireCaller(client); return { enrolled: true }; }),
      disable: jest.fn(async (_id: string, _code: string, _time: number, client: unknown) => { requireCaller(client); return { disabled: true }; }),
    };
    const jwt = { signAsync: jest.fn(async () => 'signed') };
    const auth = new AuthService(prisma, { hashPassword: jest.fn(async () => 'hash') } as any, jwt as any,
      { jwt: { accessSecret: 'synthetic-access', refreshSecret: 'synthetic-refresh' } } as any, {} as any, undefined, mfa);
    return { controller: new MfaController(mfa, auth), prisma, user, state, primary, mfa, jwt };
  }
  it.each(['verify', 'confirm', 'recovery'] as const)('keeps %s proof and issuance in one transaction with its original response shape', async action => {
    const { controller, prisma, user, state, jwt } = setup(action);
    const response = await controller[action](user as any, { code: '123456' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    if (action === 'verify') expect(response).toMatchObject({ accessToken: 'signed', mfaRequired: false });
    else expect(response).toMatchObject({ recoveryCodes: ['synthetic-code'], session: { accessToken: 'signed', mfaRequired: false } });
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true, mfaRevision: state.revision, authTime: user.authTime }), expect.any(Object));
  });
  it('rejects stale primary authentication before consuming proof', async () => {
    const { controller, user, mfa } = setup('verify');
    await expect(controller.verify({ ...user, authTime: 0 } as any, { code: '123456' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mfa.verify).not.toHaveBeenCalled();
  });
  it('rechecks the original factor revision under the fence before consuming proof', async () => {
    const { controller, user, state, mfa } = setup('verify');
    state.revision++;
    await expect(controller.verify(user as any, { code: '123456' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mfa.verify).not.toHaveBeenCalled();
  });
  it.each(['enroll', 'disable'] as const)('keeps %s inside the caller-validated transaction', async action => {
    const { controller, user, prisma, mfa } = setup(action === 'enroll' ? 'confirm' : 'recovery');
    await controller[action](user as any, { code: '123456' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); expect(mfa[action]).toHaveBeenCalledTimes(1);
  });
  it.each(['enroll', 'disable', 'confirm', 'verify', 'recovery'] as const)('rejects %s after primary revocation before consuming proof', async action => {
    const { controller, user, primary, mfa, jwt } = setup('verify'); primary.revision++;
    await expect(controller[action](user as any, { code: '123456' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mfa.verify).not.toHaveBeenCalled(); expect(mfa.enroll).not.toHaveBeenCalled(); expect(mfa.disable).not.toHaveBeenCalled(); expect(jwt.signAsync).not.toHaveBeenCalled();
  });
  it('rejects a fresh challenge from a logged-out family', async () => {
    const { controller, user, primary, mfa } = setup('verify'); primary.familyActive = false;
    await expect(controller.verify(user as any, { code: '123456' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mfa.verify).not.toHaveBeenCalled();
  });
});
