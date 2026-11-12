import { ForbiddenException } from '@nestjs/common';
import { ALLOW_MFA_PENDING } from '../mfa.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
describe('MFA authorization boundary', () => {
  function setup(payload: any, state: any, pendingRoute = false) {
    const request = { headers: { authorization: 'Bearer synthetic' } };
    const context = {
      getHandler: () => function route() {}, getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    };
    const user = { id: 'owner', email: 'owner@example.test', status: 'active', deletedAt: null, roles: [{ role: { name: 'student' } }], mfa: state };
    const guard = new JwtAuthGuard(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: 'owner', ...payload }) } as any,
      { jwt: { accessSecret: 'synthetic' } } as any,
      { user: { findUnique: jest.fn().mockResolvedValue(user) } } as any,
      { getAllAndOverride: jest.fn((key: string) => key === ALLOW_MFA_PENDING && pendingRoute) } as any,
    );
    return { guard, context: context as any, request };
  }
  it.each([
    [{}, { enabled: true, revision: 1 }],
    [{ mfaRevision: 1, mfaVerified: false }, { enabled: true, revision: 1 }],
    [{ mfaRevision: 1, mfaVerified: true }, { enabled: true, revision: 2 }],
    [{ mfaRevision: 1, mfaVerified: true }, { enabled: false, revision: 2 }],
  ])('denies old, provisional and replaced-factor tokens', async (payload, state) => {
    const { guard, context } = setup(payload, state);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('admits only currently verified tokens to normal protected APIs', async () => {
    const { guard, context } = setup({ mfaRevision: 3, mfaVerified: true }, { enabled: true, revision: 3 });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
  it('allows provisional credentials only on explicitly marked challenge endpoints', async () => {
    const { guard, context } = setup({ mfaRevision: 3, mfaVerified: false }, { enabled: true, revision: 3 }, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
  it('keeps legacy accounts without an enrolled factor compatible', async () => {
    const { guard, context } = setup({}, null);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
